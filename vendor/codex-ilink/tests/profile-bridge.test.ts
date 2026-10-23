import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { accountCodex, AccountLeaseStore } from "../src/accounts/account-scope.ts";
import { BridgeEngine, type CodexEvent } from "../src/bridge/bridge.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { OutboxWorker } from "../src/bridge/outbox-worker.ts";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import { ProfileStore } from "../src/profiles/profile-store.ts";
import { ChannelProfileService } from "../src/profiles/channel-profile.ts";
import type { WireWeixinMessage } from "../src/ilink/protocol.ts";
import { routeInboundText } from "../src/domain/route-inbound.ts";
import type { HistoryPort } from "../src/history/history-service.ts";

function fixture(t: { after(fn: () => void): void },history?:HistoryPort) {
  const root = mkdtempSync(join(tmpdir(), "ilink-profile-bridge-")); const state = new SqliteState(join(root, "state.sqlite"));
  const historyPath = join(root,"rollout.jsonl");
  writeFileSync(historyPath,[{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"HISTORY_USER"}]}},{type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"HISTORY_ANSWER"}]}},{type:"response_item",payload:{type:"custom_tool_call_output",output:"OTHER_SECRET"}}].map(r=>JSON.stringify(r)).join("\n")+"\n");
  const accounts = new AccountStore(root); accounts.register("primary", "user", "bot"); accounts.register("second", "other", "other-bot"); accounts.claimThread("primary", "legacy"); accounts.claimThread("second", "other-thread");
  const store = new ProfileStore(accounts.database, root); const listeners = new Set<(e: CodexEvent) => void>(); let next = 0; let failCreate = false; let failSend = false;
  const archives: string[] = [], reads: string[] = [], starts: string[] = []; const responses: Array<{ id: string | number; result: Record<string, unknown> }> = []; const sent: string[] = [];
  const runtime = {
    onEvent(fn: (e: CodexEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async readDefaultModelSettings() { return { model: "model-a", effort: "low" }; },
    async listModels() { return { data: [{ id: "model-a", model: "model-a", hidden: false, displayName: "A", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }] }], nextCursor: null }; },
    async startThread(cwd: string, _permissions: unknown, identity: { model: string; effort: string }) { if (failCreate) throw new Error("creation failed"); return { thread: { id: `native-${++next}` }, cwd, model: identity.model, reasoningEffort: identity.effort }; },
    async setThreadName() { return {}; },
    async resumeThread(id: string) { return { thread: { id }, model: "model-a", reasoningEffort: "low", cwd: "D:\\Inbox" }; },
    async ensureThread() {},
    async startTurn(input: { text: string; threadId: string }) { starts.push(input.text); return { turn: { id: `turn-${starts.length}` } }; },
    async archiveThread(id: string) { archives.push(id); return { thread: { id } }; },
    async listThreads() { return { data: [{ id: "legacy", name: "my-history" }, { id: "other-thread", name: "OTHER_SECRET" }], nextCursor: null }; },
    async readThread({ threadId }: { threadId: string }) { reads.push(threadId); return { thread: { id: threadId, path:historyPath, cwd: "D:\\Inbox", turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "HISTORY_USER" }] }, { type: "agentMessage", text: "HISTORY_ANSWER" }] }] } }; },
    respondToServerRequest(id: string | number, result: Record<string, unknown>) { responses.push({ id, result }); return true; },
    isServerRequestLive() { return true; },
    async updateThreadModelSettings(id: string) { return { thread: { id }, model: "model-a", reasoningEffort: "low" }; },
  } as unknown as CodexRuntime;
  const profile = new ChannelProfileService({ store, account: "primary", runtime, projects: () => [] });
  const codex = accountCodex(runtime, accounts, "primary", profile); const leases = new AccountLeaseStore(join(root,"state.sqlite"), accounts, "primary");
  const session = { botId: "bot", botToken: "fake", controllerUserId: "user", baseUrl: "https://example.invalid" };
  state.bindController({ accountId: "bot", userId: "user", boundAtMs: 1 }); state.setMainThreadId("legacy");
  const ilink = { async sendText(input: { text: string; clientId: string }) { if (failSend) throw new Error("offline"); sent.push(input.text); return { accepted: true as const, clientId: input.clientId }; } };
  let messageId = 0;
  let now = 1000;
  const bridge = new BridgeEngine({ profile, ...(history?{history}:{}), bridgeInstanceId: "test-host", codex, state, leases, session, ilink, inboxDirectory: "D:\\Inbox", mainThreadId: "legacy", newThreadPermissions: () => ({ permissions: ":read-only" }), newId: () => crypto.randomUUID(), now: () => now });
  const ingest = (text: string, voice = false) => bridge.ingestBatch({ cursor: `cursor-${++messageId}`, messages: [{ message_id: messageId, from_user_id: "user", context_token: `ctx-${messageId}`, item_list: voice ? [{ type: 3, voice_item: { text } }] : [{ type: 1, text_item: { text } }] } as WireWeixinMessage] });
  t.after(() => { leases.close(); state.close(); accounts.close(); rmSync(root,{ recursive:true, force:true }); });
  return { bridge, profile, store, state, codex, leases, sent, archives, reads, responses, starts, listeners, ingest, session, ilink, advance(ms: number) { now += ms; }, failCreate() { failCreate = true; }, failSend(value: boolean) { failSend = value; } };
}
test("WeChat history uses the fixed command port; voice transcription cannot enable policy",async t=>{
  const commands:string[]=[];const f=fixture(t,{command:async text=>{commands.push(text);return "HISTORY_POLICY_OK";},tick:async()=>{}});
  await f.ingest("history policy");assert.deepEqual(commands,["history policy"]);assert.equal(f.sent.at(-1),"HISTORY_POLICY_OK");
  await f.ingest("history enable",true);assert.equal(commands.length,1);assert.match(f.starts[0]!,/不能作为永久配置/);
});
test("profile session remains selected after a year idle; status has no countdown and exit is explicit", async t => {
  const f=fixture(t); await f.ingest("new"); const id=f.state.getBinding(1000)!.threadId;
  assert.match(f.sent.at(-1)!,/不会因无活动自动退出/);
  f.advance(365*24*60*60*1000); await f.ingest("st");
  assert.equal(f.state.getBinding(365*24*60*60*1000)!.threadId,id); assert.match(f.sent.at(-1)!,/持续保持/); assert.doesNotMatch(f.sent.at(-1)!,/剩余.*分钟/);
  await f.ingest("exit"); assert.equal(f.state.getBinding(1000),null);
});
test("persistent session upgrades an old expired binding and persists across state reopen without archiving", t => {
  const root=mkdtempSync(join(tmpdir(),"ilink-sticky-"));const path=join(root,"state.sqlite"); let state=new SqliteState(path);
  t.after(()=>{state.close();rmSync(root,{recursive:true,force:true})});
  state.setBinding({threadId:"previous-session",projectPath:null,updatedAtMs:1,expiresAtMs:2}); assert.equal(state.getBinding(1000),null);
  state.enablePersistentSessionBinding(); assert.equal(state.getBinding(1000)!.threadId,"previous-session"); assert.equal(state.getExpiredBindingForReminder(1000),null);
  state.close();state=new SqliteState(path);assert.equal(state.getBinding(365*24*60*60*1000)!.threadId,"previous-session");
});
test("background notification cannot replace persistent selection or implicitly leave main after exit", () => {
  const input={persistentSession:true,nowMs:999999999999,text:"继续",mainThreadId:"main",notificationWindows:[{threadId:"background",deliveredAtMs:100,expiresAtMs:Number.MAX_SAFE_INTEGER}]};
  const selected=routeInboundText({...input,binding:{threadId:"selected",updatedAtMs:1,expiresAtMs:2}});assert.equal(selected.kind,"turn");if(selected.kind==="turn")assert.equal(selected.threadId,"selected");
  const main=routeInboundText({...input,binding:null});assert.equal(main.kind,"turn");if(main.kind==="turn")assert.equal(main.threadId,"main");
});
test("WeChat config -> new -> saved edit -> new -> exit/clear retains independent snapshots and legacy", async t => {
  const f = fixture(t); await f.ingest("config set name 小白狐"); await f.ingest("new"); const first = f.state.getBinding(1000)!.threadId;
  assert.equal(f.store.thread(first)!.profile.persona.name,"小白狐");
  await f.ingest("config set name 小棕狐"); assert.equal(f.store.thread(first)!.profile.persona.name,"小白狐");
  await f.ingest("new"); const second = f.state.getBinding(1000)!.threadId; assert.notEqual(first,second); assert.equal(f.store.thread(second)!.profile.persona.name,"小棕狐");
  await f.ingest("exit"); await f.ingest("st"); assert.match(f.sent.at(-1)!,/旧会话/); assert.equal(f.store.thread("legacy"),null);
  await f.ingest("clear"); assert.notEqual(f.state.getBridgeSettings().mainThreadId,"legacy"); assert.ok(f.archives.includes("legacy"));
  const main = f.state.getBridgeSettings().mainThreadId!; assert.equal(f.store.thread(main)!.profile.persona.name,"小棕狐");
  await f.codex.updateThreadModelSettings(main,{ model:"model-a", effort:"low" });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM thread_model_overrides").get()!.n,1); assert.equal(f.store.load("primary").session.model,null);
});
test("new refuses an active lease; failed clear preserves original binding and never archives old thread", async t => {
  const f = fixture(t); await f.ingest("config"); const lease = f.leases.tryAcquire({ threadId:"legacy", owner:"desktop", instanceId:"desktop", operationId:"busy", turnId:"desktop-turn", createdAtMs:1 }); assert.ok(lease.acquired);
  await f.ingest("new"); assert.equal(f.state.getBinding(1000),null); assert.match(f.sent.at(-1)!,/仍有任务/); if(lease.acquired) f.leases.release(lease.lease);
  f.failCreate(); await f.ingest("clear"); assert.equal(f.state.getBridgeSettings().mainThreadId,"legacy"); assert.equal(f.state.getBinding(1000),null); assert.deepEqual(f.archives,[]);
});
test("voice-transcribed config cannot change permanent profile", async t => {
  const f = fixture(t); await f.ingest("config"); await f.ingest("config set name 不应生效",true);
  assert.equal(f.store.load("primary").persona.name,"电脑管家"); assert.equal(f.store.load("primary").revision,1); assert.match(f.starts[0]!,/不能作为永久配置/);
});
test("long config show is durably split before first send and recovered without losing JSON text", async t => {
  const f = fixture(t); await f.ingest(`config set role ${"长角色定义".repeat(700)}`); const expected = JSON.stringify(f.store.load("primary"),null,2); f.sent.length=0; f.failSend(true);
  await assert.rejects(f.ingest("config show"),/offline/); assert.ok(f.state.listPendingOutbox().length>2);
  f.failSend(false); const worker = new OutboxWorker({ ilink:f.ilink,state:f.state,session:f.session,now:()=>2000 }); await worker.drain();
  assert.equal(f.sent.join(""),expected); assert.ok(f.sent.every(s=>Buffer.byteLength(s)<=2000));
});
test("channel_history lists and reads only the authenticated channel, hides other users and tool outputs", async t => {
  const f = fixture(t); const off=f.codex.onEvent(()=>{});
  const emit=(id:number,args:unknown)=>{for(const fn of f.listeners)fn({id,method:"item/tool/call",params:{threadId:"legacy",tool:"channel_history",arguments:args}})};
  emit(1,{}); emit(2,{threadId:"legacy"}); emit(3,{threadId:"other-thread"});
  const deadline=Date.now()+2000; while(f.responses.length<3&&Date.now()<deadline) await new Promise(r=>setTimeout(r,10)); off();
  assert.equal(f.responses.length,3); assert.ok(f.responses.some(r=>r.id===3&&r.result.success===false));
  assert.deepEqual(f.reads,["legacy"]); const output=JSON.stringify(f.responses); assert.match(output,/HISTORY_USER/); assert.match(output,/HISTORY_ANSWER/); assert.doesNotMatch(output,/OTHER_SECRET/);
});
