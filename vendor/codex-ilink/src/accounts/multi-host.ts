import {recentHistory} from "./recent-history.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteState } from "../bridge/sqlite-state.ts";
import { CodexRuntime } from "../codex/codex-runtime.ts";
import { BridgeDaemon } from "../daemon/bridge-daemon.ts";
import { HookReceiver } from "../hooks/hook-receiver.ts";
import { ILinkClient } from "../ilink/ilink-client.ts";
import { InboundMediaStore } from "../media/inbound-media.ts";
import { unprotectForCurrentUser } from "../windows/dpapi.ts";
import { readDesktopPermissionSelection } from "../windows/desktop-permissions.ts";
import { desktopGlobalStatePath, readDesktopProjects } from "../windows/desktop-projects.ts";
import { HostControlServer, hostControlPipePath, desktopCodexAppServerCommand, runSerialPollingLoop, type RunWindowsHostOptions, type HostPhase } from "../windows/host.ts";
import { createPowerRequestCommand, PowerRequestController } from "../windows/power-request.ts";
import { getPresence, getPresenceObservation } from "../windows/presence.ts";
import { runtimePaths } from "../windows/runtime-paths.ts";
import { AccountStore } from "./account-store.ts";
import { accountCodex, AccountLeaseStore } from "./account-scope.ts";
import { ProfileStore } from "../profiles/profile-store.ts";
import { ChannelProfileService } from "../profiles/channel-profile.ts";
import { HistoryService } from "../history/history-service.ts";
import { createChannelMemory, v2AccountEnabled } from "../memory/service.ts";
import { configuredMemoryExtractor } from "../memory/http-extractor.ts";
import { isDesktopThreadPinned } from "../windows/desktop-pins.ts";
import {runtimeConfigurationFingerprint} from "../windows/runtime-configuration.ts";
import {DelegationService,DelegationStore,initializeDelegationPermissions} from "../delegation/delegation-service.ts";
import {DesktopTaskCreator} from "../delegation/create-task.ts";
import {OfficialDesktopTools} from "../delegation/desktop-tools.ts";
import {startDelegationServer,type DelegationHandler} from "../delegation/ipc.ts";
import {userPipePath} from "../windows/runtime-paths.ts";
import type {Server} from "node:net";
import {resolveDelegationTargets} from "../delegation/catalog.ts";
import {ChannelMemory} from "../memory/channel-memory.ts";
import {ChannelConversation} from "../interaction/conversation.ts";
import {startInteractionPanel,panelChannel,type PanelChannel} from "../interaction/panel.ts";

/** One host and execution runtime; background reads have a separate fault domain. */
export async function runMultiAccountHost(options: RunWindowsHostOptions): Promise<void> {
  if (process.platform !== "win32") throw new Error("E_HOST_WINDOWS_ONLY");
  const environment = options.environment ?? process.env;
  if (!environment.LOCALAPPDATA) throw new Error("E_LOCALAPPDATA_REQUIRED");
  const paths = runtimePaths(environment);
  mkdirSync(paths.logDirectory, { recursive: true });
  const abort = new AbortController();
  const forward = () => abort.abort(options.signal?.reason);
  if (options.signal?.aborted) forward();
  else options.signal?.addEventListener("abort", forward, { once: true });
  const startedAtMs = Date.now();
  let phase: HostPhase = "starting";
  const channels = new Map<string, { daemon: BridgeDaemon; state: SqliteState; leases: AccountLeaseStore; polling?: Promise<void> }>();
  const statuses = new Map<string, { phase: string; pausedUntilMs?: number }>();
  const panelChannels=new Map<string,PanelChannel>();
  let interactionPanel:Awaited<ReturnType<typeof startInteractionPanel>>|undefined;
  const control = await HostControlServer.start({
    pipePath: hostControlPipePath(environment),
    onStatus: () => ({ phase, pid: process.pid, startedAtMs, accounts: Object.fromEntries(statuses),...(interactionPanel?{interactionPanel:interactionPanel.origin}:{}) }),
    onStop: () => { phase = "stopping"; abort.abort(new Error("E_HOST_STOP_REQUESTED")); },
  });
  let store: AccountStore | undefined;
  let codex: CodexRuntime | undefined;
  let observer: CodexRuntime | undefined;
  let receiver: HookReceiver | undefined;
  let delegationServer:Server|undefined;
  const delegationHandlers=new Map<string,DelegationHandler>();
  const power = new PowerRequestController(createPowerRequestCommand());
  const counts = new Map<string, number>();
  const delegations=new Map<string,DelegationService>();
  let powerWork = Promise.resolve();
  try {
    store = new AccountStore(paths.dataDirectory);
    store.importPrimary();
    const accounts = store;
    if (accounts.list().some(a => v2AccountEnabled(environment, a.name))) {
      try {
        interactionPanel = await startInteractionPanel({ channels: panelChannels, accessFile: join(accounts.root, "interaction-panel-access.json") });
      } catch {
        console.error("[ilink:interaction-panel] local control page unavailable");
      }
    }
    const delegationStore=new DelegationStore(accounts.database);delegationStore.recover();
    initializeDelegationPermissions(accounts.root,accounts.list().map(a=>a.name));
    const delegationPipe=`${userPipePath(environment)}-delegation`;
    delegationServer=await startDelegationServer(delegationPipe,async(context,args)=>{const handler=delegationHandlers.get(accounts.owner(context.threadId));if(!handler)throw Error("委派通道未准备好");return handler(context,args);});
    const bridgeInstanceId = randomUUID();
    codex = await CodexRuntime.create({ bridgeInstanceId, command: desktopCodexAppServerCommand(environment), environment,delegationPipe,
      commandResolver:()=>desktopCodexAppServerCommand(environment),
      configurationFingerprint:()=>runtimeConfigurationFingerprint(environment),
      onDiagnostic:event=>console.error(`[ilink:execution] ${JSON.stringify({at:new Date().toISOString(),...event})}`) });
    const runtime = codex;
    observer = await CodexRuntime.create({ bridgeInstanceId, command: desktopCodexAppServerCommand(environment), environment,
      commandResolver:()=>desktopCodexAppServerCommand(environment),
      configurationFingerprint:()=>runtimeConfigurationFingerprint(environment),
      onDiagnostic:event=>console.error(`[ilink:observer] ${JSON.stringify({at:new Date().toISOString(),...event})}`) });
    const observationRuntime = observer;
    const profiles = new ProfileStore(accounts.database, accounts.root);
    runtime.setThreadInstructionResolver(id => profiles.thread(id)?.instructions);
    receiver = new HookReceiver({
      pipePath: paths.pipePath, spoolDirectory: paths.spoolDirectory,
      onEvent: (event, signal) => channels.get(accounts.owner(event.sessionId))?.daemon.ingestHookEvent(event, signal),
    });
    const hooks = receiver;
    const startAccount = async (name: string): Promise<void> => {
      if (channels.has(name)) return;
      const directory = accounts.stateDirectory(name);
      const state = accounts.openState(name);
      let leases: AccountLeaseStore | undefined;
      let daemon: BridgeDaemon | undefined;
      try {
        const stored = state.getILinkSession();
        const registered = accounts.list().find(a => a.name === name);
        if (!stored || stored.controllerUserId !== registered?.userId || stored.botId !== registered.botId) throw new Error("E_ACCOUNT_BINDING_MISMATCH");
        const session = { baseUrl: stored.baseUrl, botId: stored.botId, controllerUserId: stored.controllerUserId, botToken: unprotectForCurrentUser(stored.protectedToken) };
        const main = state.getBridgeSettings().mainThreadId;
        if (main) accounts.claimThread(name, main);
        leases = new AccountLeaseStore(paths.stateDatabasePath, accounts, name);
        const ilink = new ILinkClient({ onAuthExpired: ({ pausedUntilMs }) => statuses.set(name, { phase: "auth-paused", pausedUntilMs }) });
        const idle = () => state.getBridgeSettings().awayTimeoutMinutes * 60_000;
        const v2Enabled = v2AccountEnabled(environment, name);
        const profile = new ChannelProfileService({ store: profiles, account: name, runtime, compilerVersion: v2Enabled ? 2 : 1, projects: () => readDesktopProjects(desktopGlobalStatePath(environment)) });
        const creation=new DesktopTaskCreator({db:accounts.database,account:name,tools:()=>new OfficialDesktopTools(environment),models:()=>profile.models(),defaultModel:async cwd=>(await runtime.readDefaultModelSettings(cwd)).model,claim:id=>accounts.claimThread(name,id),track:job=>delegationStore.save(job)});
        const delegation=new DelegationService({creation,account:name,store:delegationStore,root:accounts.root,
          owner:id=>accounts.owner(id),explicitOwner:id=>accounts.explicitOwner(id),tools:()=>new OfficialDesktopTools(environment),
          activeBridgeThreads:()=>runtime.activeThreadIds(),
          readInspection:async id=>{const {thread}=await observationRuntime.readThread({threadId:id,includeTurns:false});return {thread:{status:thread.status},history:await recentHistory(thread.path,"")};},
          readResult:async(id,turn)=>{let cursor:string|undefined;const seen=new Set<string>();for(let n=0;n<50;n++){const page=await observationRuntime.readRecentTurns(id,cursor);const found=(page.data as Array<Record<string,any>>).find(t=>t.id===turn);if(found)return found.items.filter((i:any)=>i.type==="agentMessage"&&i.phase==="final_answer").map((i:any)=>i.text).join("\n");if(typeof page.nextCursor!=="string"||seen.has(page.nextCursor))break;cursor=page.nextCursor;seen.add(cursor);}throw Error("E_DELEGATION_RESULT_NOT_FOUND");},
          resolve:async (selector, purpose)=>{
            if(/^[0-9a-f-]{36}$/iu.test(selector)){
              const {thread}=await observationRuntime.readThread({threadId:selector,includeTurns:false});
              if (thread.id !== selector) throw Error("E_DELEGATION_TARGET_MISMATCH");
              return [{id:thread.id,title:String(thread.name??thread.preview??selector)}];
            }
            return resolveDelegationTargets(selector, readDesktopProjects(desktopGlobalStatePath(environment)), (search, cursor, cwd) => observationRuntime.findDelegationThreads(search, cursor, cwd), purpose === "inspect");
          },notify:async(job,text,key)=>await daemon?.notifyDelegation(text,key,job.contextToken)??false});
        const extractor = v2Enabled ? configuredMemoryExtractor(environment) : undefined;
        const scopedObserver=accountCodex(observationRuntime,accounts,name);
        const memoryBase = v2Enabled ? createChannelMemory(accounts, name, extractor ? { extractor, historyReader: { async read(id, cursor) {
          const page = await scopedObserver.readRecentTurns(id, cursor);
          if (!Array.isArray(page.data) || (page.nextCursor !== null && typeof page.nextCursor !== "string")) throw Error("E_MEMORY_HISTORY_PAGE");
          return { data: page.data, nextCursor: page.nextCursor as string | null };
        } } } : {}) : undefined;
        const interactionEnabled=v2AccountEnabled({...environment,ILINK_V2_ACCOUNTS:environment.ILINK_INTERACTION_ACCOUNTS},name);
        const memory=memoryBase instanceof ChannelMemory?new ChannelConversation(memoryBase,{enabledByDefault:interactionEnabled,profile:id=>profiles.thread(id,name)?.profile??profiles.load(name),panelUrl:()=>interactionPanel?.urlFor(name)}):memoryBase;
        if(memory instanceof ChannelConversation){panelChannels.set(name,panelChannel(memory,()=>state.getBinding(Date.now())?.threadId??state.getBridgeSettings().mainThreadId??""));interactionPanel?.urlFor(name);}
        const scopedCodex=accountCodex(runtime,accounts,name,profile,{service:delegation,state,register:handler=>delegationHandlers.set(name,handler)},memory);
        const historyCodex=new Proxy(scopedCodex,{get(target,key){return key === "readThread" ? scopedObserver.readThread : Reflect.get(target,key);}});
        const history=new HistoryService({accounts,account:name,codex:historyCodex,state,leases,instanceId:bridgeInstanceId,now:Date.now,approvalBusy:id=>daemon?.hasPendingApproval(id)??true,desktopPinned:id=>isDesktopThreadPinned(id,environment),notify:async(text,id)=>{await daemon?.notifyHistory(text,id);}});
        // Invalid hand edits must not interrupt old sessions or account polling.
        try { profiles.initialize(name); } catch { console.error(`[ilink:${name}] profile requires config reload or local repair`); }
        daemon = new BridgeDaemon({
          bridgeInstanceId, state, session, leases,
          codex: scopedCodex, terminalReader:scopedObserver, ilink, profile, history, ...(memory ? { memory } : {}),
          // Only the host closes/listens on the shared pipe. Per-account polls
          // can safely ask the receiver to drain its serialized spool.
          hookReceiver: { start: async () => {}, close: async () => {}, drainSpool: () => hooks.drainSpool() },
          inboxDirectory: join(directory, "Inbox"),
          media: new InboundMediaStore({ rootDirectory: join(directory, "media", "inbound") }),
          listProjects: () => readDesktopProjects(desktopGlobalStatePath(environment)),
          newThreadPermissions: () => readDesktopPermissionSelection(desktopGlobalStatePath(environment)).settings,
          newId: randomUUID, now: Date.now,
          presence: () => getPresence(undefined, idle()),
          presenceObservation: () => getPresenceObservation(undefined, idle()),
          activeTaskCounter: { setActiveTaskCount: async count => {
            counts.set(name, count);
            powerWork = powerWork.catch(() => {}).then(() => power.setActiveTaskCount([...counts.values()].reduce((a, b) => a + b, 0)));
            await powerWork;
          } },
          onLifecycleWarning: operation => console.error(`[ilink:${name}] ${operation} failed`),
        });
        const channel = { daemon, state, leases };
        channels.set(name, channel);
        statuses.set(name, { phase: "starting" });
        await daemon.start();
        delegations.set(name,delegation);
        statuses.set(name, { phase: "running" });
        const polling = runSerialPollingLoop({
          signal: abort.signal,
          poll: async signal => { await channel.daemon.pollOnce(signal); statuses.set(name, { phase: "running" }); },
          onRetry: (error, delay, failures) => {
            statuses.set(name, { phase: "retrying", pausedUntilMs: Date.now() + delay });
            options.onRetry?.(error, delay, failures);
            console.error(`[ilink:${name}] poll retry in ${delay}ms`);
          },
        }).catch(() => { statuses.set(name, { phase: "failed" }); });
        Object.assign(channel, { polling });
      } catch (error) {
        if (daemon) await daemon.stop().catch(() => {});
        channels.delete(name); leases?.close(); state.close();
        delegationHandlers.delete(name);delegations.delete(name);
        panelChannels.delete(name);
        statuses.set(name, { phase: "failed" });
        throw error;
      }
    };
    // Primary failure is visible at process startup; a bad added account never
    // tears down the working primary account.
    await startAccount("primary");
    await hooks.start();
    await hooks.drainSpool();
    phase = "running";
    while (!abort.signal.aborted) {
      for(const delegation of delegations.values()){if(abort.signal.aborted)break;await delegation.tick().catch(()=>console.error("[ilink] delegation maintenance deferred"));}
      for (const account of accounts.list()) {
        if (abort.signal.aborted) break;
        if (!channels.has(account.name)) await startAccount(account.name).catch(() => console.error(`[ilink:${account.name}] account startup failed; will retry`));
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 3_000);
        abort.signal.addEventListener("abort", done, { once: true });
        if (abort.signal.aborted) done();
      });
    }
  } finally {
    phase = "stopping";
    abort.abort();
    options.signal?.removeEventListener("abort", forward);
    const errors: unknown[] = [];
    const attempt = async (fn: () => unknown) => { try { await fn(); } catch (e) { errors.push(e); } };
    await attempt(() => receiver?.stopAccepting());
    await attempt(() => interactionPanel?.close());
    await Promise.all([...channels.values()].map(c => c.polling));
    for (const channel of channels.values()) await attempt(() => channel.daemon.stop());
    await attempt(() => receiver?.close());
    await attempt(() => codex?.close());
    await attempt(() => observer?.close());
    if(delegationServer)await attempt(()=>new Promise<void>(resolve=>delegationServer!.close(()=>resolve())));
    await attempt(() => powerWork);
    await attempt(() => power.close());
    for (const channel of channels.values()) { await attempt(() => channel.leases.close()); await attempt(() => channel.state.close()); }
    await attempt(() => store?.close());
    await attempt(() => control.close());
    if (errors.length) throw new AggregateError(errors, "E_MULTI_ACCOUNT_SHUTDOWN");
  }
}
