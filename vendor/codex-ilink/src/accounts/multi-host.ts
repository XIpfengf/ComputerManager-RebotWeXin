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
import { isDesktopThreadPinned } from "../windows/desktop-pins.ts";

/** One Windows host, one Codex, one Hook listener. Account transports fail independently. */
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
  const control = await HostControlServer.start({
    pipePath: hostControlPipePath(environment),
    onStatus: () => ({ phase, pid: process.pid, startedAtMs, accounts: Object.fromEntries(statuses) }),
    onStop: () => { phase = "stopping"; abort.abort(new Error("E_HOST_STOP_REQUESTED")); },
  });
  let store: AccountStore | undefined;
  let codex: CodexRuntime | undefined;
  let receiver: HookReceiver | undefined;
  const power = new PowerRequestController(createPowerRequestCommand());
  const counts = new Map<string, number>();
  let powerWork = Promise.resolve();
  try {
    store = new AccountStore(paths.dataDirectory);
    store.importPrimary();
    const accounts = store;
    const bridgeInstanceId = randomUUID();
    codex = await CodexRuntime.create({ bridgeInstanceId, command: desktopCodexAppServerCommand(environment), environment });
    const runtime = codex;
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
        const profile = new ChannelProfileService({ store: profiles, account: name, runtime, projects: () => readDesktopProjects(desktopGlobalStatePath(environment)) });
        const scopedCodex=accountCodex(runtime,accounts,name,profile);
        const history=new HistoryService({accounts,account:name,codex:scopedCodex,state,leases,instanceId:bridgeInstanceId,now:Date.now,approvalBusy:id=>daemon?.hasPendingApproval(id)??true,desktopPinned:id=>isDesktopThreadPinned(id,environment),notify:async(text,id)=>{await daemon?.notifyHistory(text,id);}});
        // Invalid hand edits must not interrupt old sessions or account polling.
        try { profiles.initialize(name); } catch { console.error(`[ilink:${name}] profile requires config reload or local repair`); }
        daemon = new BridgeDaemon({
          bridgeInstanceId, state, session, leases,
          codex: scopedCodex, ilink, profile, history,
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
    await Promise.all([...channels.values()].map(c => c.polling));
    for (const channel of channels.values()) await attempt(() => channel.daemon.stop());
    await attempt(() => receiver?.close());
    await attempt(() => codex?.close());
    await attempt(() => powerWork);
    await attempt(() => power.close());
    for (const channel of channels.values()) { await attempt(() => channel.leases.close()); await attempt(() => channel.state.close()); }
    await attempt(() => store?.close());
    await attempt(() => control.close());
    if (errors.length) throw new AggregateError(errors, "E_MULTI_ACCOUNT_SHUTDOWN");
  }
}
