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
import { ChannelMemory } from "../src/memory/channel-memory.ts";
import type { MemoryExtractor } from "../src/memory/extraction.ts";
import type { MemoryHistoryReader } from "../src/memory/backfill.ts";
import {ChannelConversation} from "../src/interaction/conversation.ts";

function fixture(t: { after(fn: () => void): void },history?:HistoryPort, extractor?: MemoryExtractor, historyReader?: MemoryHistoryReader,interaction=false) {
  const root = mkdtempSync(join(tmpdir(), "ilink-profile-bridge-")); const state = new SqliteState(join(root, "state.sqlite"));
  const historyPath = join(root,"rollout.jsonl");
  writeFileSync(historyPath,[{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"HISTORY_USER"}]}},{type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"HISTORY_ANSWER"}]}},{type:"response_item",payload:{type:"custom_tool_call_output",output:"OTHER_SECRET"}}].map(r=>JSON.stringify(r)).join("\n")+"\n");
  const accounts = new AccountStore(root); accounts.register("primary", "user", "bot"); accounts.register("second", "other", "other-bot"); accounts.claimThread("primary", "legacy"); accounts.claimThread("second", "other-thread");
  const store = new ProfileStore(accounts.database, root); const listeners = new Set<(e: CodexEvent) => void>(); let next = 0; let failCreate = false; let failSend = false;
  const turnInputs: Array<Parameters<CodexRuntime["startTurn"]>[0]> = [];
  const createdIdentities: Array<Parameters<CodexRuntime["startThread"]>[2]> = [];
  const finalTurns = new Map<string, { id: string; items: unknown[]; status: string }>();
  const archives: string[] = [], reads: string[] = [], starts: string[] = []; const responses: Array<{ id: string | number; result: Record<string, unknown> }> = []; const sent: string[] = [];
  const runtime = {
    onEvent(fn: (e: CodexEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
    async readDefaultModelSettings() { return { model: "model-a", effort: "low" }; },
    async listModels() { return { data: [{ id: "model-a", model: "model-a", hidden: false, displayName: "A", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }] }], nextCursor: null }; },
    async startThread(cwd: string, _permissions: unknown, identity: { model: string; effort: string }) { if (failCreate) throw new Error("creation failed"); createdIdentities.push(identity); return { thread: { id: `native-${++next}` }, cwd, model: identity.model, reasoningEffort: identity.effort }; },
    async setThreadName() { return {}; },
    async resumeThread(id: string) { return { thread: { id }, model: "model-a", reasoningEffort: "low", cwd: "D:\\Inbox" }; },
    async ensureThread() {},
    async startTurn(input: Parameters<CodexRuntime["startTurn"]>[0]) { turnInputs.push(input); starts.push(input.text); return { turn: { id: `turn-${starts.length}` } }; },
    async archiveThread(id: string) { archives.push(id); return { thread: { id } }; },
    async listThreads() { return { data: [{ id: "legacy", name: "my-history" }, { id: "other-thread", name: "OTHER_SECRET" }], nextCursor: null }; },
    async readThread({ threadId }: { threadId: string }) { reads.push(threadId); return { thread: { id: threadId, path:historyPath, cwd: "D:\\Inbox", turns: finalTurns.has(threadId) ? [finalTurns.get(threadId)] : [{ items: [{ type: "userMessage", content: [{ type: "text", text: "HISTORY_USER" }] }, { type: "agentMessage", text: "HISTORY_ANSWER" }] }] } }; },
    respondToServerRequest(id: string | number, result: Record<string, unknown>) { responses.push({ id, result }); return true; },
    isServerRequestLive() { return true; },
    async updateThreadModelSettings(id: string) { return { thread: { id }, model: "model-a", reasoningEffort: "low" }; },
  } as unknown as CodexRuntime;
  const profile = new ChannelProfileService({ store, account: "primary", runtime, projects: () => [] });
  const memory = new ChannelMemory(accounts, "primary", { ...(extractor ? { extractor } : {}), ...(historyReader ? { historyReader } : {}) });
  const conversation=interaction?new ChannelConversation(memory,{enabledByDefault:true,profile:id=>store.thread(id,"primary")?.profile??store.load("primary")}):undefined;
  const codex = accountCodex(runtime, accounts, "primary", profile, undefined, memory); const leases = new AccountLeaseStore(join(root,"state.sqlite"), accounts, "primary");
  const session = { botId: "bot", botToken: "fake", controllerUserId: "user", baseUrl: "https://example.invalid" };
  state.bindController({ accountId: "bot", userId: "user", boundAtMs: 1 }); state.setMainThreadId("legacy");
  const ilink = { async sendText(input: { text: string; clientId: string }) { if (failSend) throw new Error("offline"); sent.push(input.text); return { accepted: true as const, clientId: input.clientId }; } };
  let messageId = 0;
  let now = 1000;
  const bridge = new BridgeEngine({ memory:conversation??memory, profile, ...(history?{history}:{}), bridgeInstanceId: "test-host", codex, state, leases, session, ilink, inboxDirectory: "D:\\Inbox", mainThreadId: "legacy", newThreadPermissions: () => ({ permissions: ":read-only" }), newId: () => crypto.randomUUID(), now: () => now });
  const ingest = (text: string, voice = false) => bridge.ingestBatch({ cursor: `cursor-${++messageId}`, messages: [{ message_id: messageId, from_user_id: "user", context_token: `ctx-${messageId}`, item_list: voice ? [{ type: 3, voice_item: { text } }] : [{ type: 1, text_item: { text } }] } as WireWeixinMessage] });
  t.after(() => { leases.close(); state.close(); accounts.close(); rmSync(root,{ recursive:true, force:true }); });
  return { bridge, memory, accounts, turnInputs, createdIdentities, setFinal(threadId: string, turnId: string, text: string) { finalTurns.set(threadId, { id: turnId, status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text }] }); }, profile, store, state, codex, leases, sent, archives, reads, responses, starts, listeners, ingest, session, ilink, advance(ms: number) { now += ms; }, failCreate() { failCreate = true; }, failSend(value: boolean) { failSend = value; } };
}

test("fixed persona and bounded memory reach the same generation; direct-result text and final semantics survive delivery", async t => {
  const f = fixture(t); await f.ingest("config set name 合成角色"); await f.ingest("memory enable"); await f.ingest("memory remember 我希望回复简短");
  await f.ingest("new"); const threadId = f.state.getBinding(1000)!.threadId;
  const snapshot = JSON.stringify(f.store.thread(threadId));
  const text = "直接给结果：以后怎么回复？并说明审批状态。";
  await f.ingest(text);
  assert.equal(f.turnInputs[0]!.text, text); assert.match(f.createdIdentities[0]!.developerInstructions!, /合成角色.*直接给结果/s);
  assert.match(JSON.stringify(f.turnInputs[0]!.additionalContext), /我希望回复简短/);
  const final = "未执行。结果：-7。审批尚未通过。";
  f.setFinal(threadId, "turn-1", final);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(f.sent.at(-1), final); assert.equal(JSON.stringify(f.store.thread(threadId)), snapshot);
});

test("explicit memory reaches a new session through normal dispatch without changing identity or user text", async t => {
  const f = fixture(t);
  await f.ingest("memory enable"); assert.match(f.sent.at(-1)!, /已开启/);
  await f.ingest("memory remember 我喜欢米饭"); assert.match(f.sent.at(-1)!, /已记住/);
  await f.ingest("memory show"); assert.match(f.sent.at(-1)!, /米饭.*legacy/s);
  await f.ingest("new"); const id = f.state.getBinding(1000)!.threadId;
  const identity = JSON.stringify(f.store.thread(id));
  await f.ingest("今晚吃什么");
  assert.equal(f.turnInputs[0]!.text, "今晚吃什么");
  assert.match(JSON.stringify(f.turnInputs[0]!.additionalContext), /untrusted.*米饭/s);
  assert.equal(JSON.stringify(f.store.thread(id)), identity);
  assert.equal(f.store.thread("legacy"), null);
  assert.equal(f.turnInputs.length, 1);
});

test("voice and quoted WeChat material cannot operate memory controls", async t => {
  const f = fixture(t);
  await f.ingest("memory enable", true);
  assert.equal(await f.memory.command("memory status", { threadId: "legacy", messageId: "check", nowMs: 1 }), "记忆未开启；自动采集不可用。");
  await f.bridge.ingestBatch({ cursor: "ref", messages: [{ message_id: 99, from_user_id: "user", context_token: "ref", item_list: [{ type: 1, text_item: { text: "memory enable" }, ref_msg: { title: "quoted" } }] } as WireWeixinMessage] });
  assert.match(await f.memory.command("memory status", { threadId: "legacy", messageId: "check", nowMs: 1 }), /未开启/);
});

test("queued execution loads current bounded memory and read failures preserve ordinary task dispatch", async t => {
  const f = fixture(t);
  await f.ingest("memory enable");
  await f.ingest("普通任务"); assert.deepEqual(f.turnInputs[0]!.additionalContext, {});
  await f.ingest("按偏好回答排队问题"); assert.equal(f.turnInputs.length, 1);
  await f.ingest("memory remember 我偏好简短回答");
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-1", status: "failed" } } });
  assert.equal(f.turnInputs[1]!.text, "按偏好回答排队问题");
  assert.match(JSON.stringify(f.turnInputs[1]!.additionalContext), /简短回答/);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-2", status: "failed" } } });
  f.memory.context = () => { throw Error("synthetic storage failure"); };
  await f.ingest("故障时普通任务"); assert.equal(f.turnInputs[2]!.text, "故障时普通任务");
  assert.match(JSON.stringify(f.turnInputs[2]!.additionalContext), /unavailable/);
  assert.doesNotMatch(JSON.stringify(f.turnInputs[2]!.additionalContext), /简短回答/);
});

test("authorized reference reads and assistant retellings remain reference data across later sessions", async t => {
  const f = fixture(t); f.codex.onEvent(() => {});
  await f.ingest("memory enable"); await f.ingest("查旧谈话供参考");
  for (const fn of f.listeners) fn({ id: 501, method: "item/tool/call", params: { threadId: "legacy", turnId: "turn-1", tool: "channel_history", arguments: { threadId: "desktop-reference" } } });
  const deadline = Date.now() + 2000;
  while (!f.responses.some(r => r.id === 501) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.responses.find(r => r.id === 501)!.result.success, true);
  assert.deepEqual(f.reads, ["desktop-reference"]);
  for (const fn of f.listeners) fn({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "转述外部用户喜欢咖啡" }] } } });
  assert.equal(f.memory.provenance.check(JSON.stringify(["assistant", "legacy", "turn-1"]), "legacy").eligible, false);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-1", status: "failed" } } });
  await f.ingest("memory remember 我决定今后回复简短");
  await f.ingest("new"); await f.ingest("以后怎么回复");
  assert.match(JSON.stringify(f.turnInputs.at(-1)!.additionalContext), /回复简短/);
  assert.doesNotMatch(JSON.stringify(f.turnInputs.at(-1)!.additionalContext), /咖啡|HISTORY_USER|HISTORY_ANSWER/);
});

test("normal original messages are extracted in the background for another session without collecting assistant text", async t => {
  const inputs: string[] = [];
  const f = fixture(t, undefined, { async extract(input) {
    inputs.push(input.evidence[0]!.text);
    return { facts: [{ subject: "user", category: "preference", sourceId: input.evidence[0]!.id, content: input.evidence[0]!.text }] };
  } });
  await f.ingest("memory enable"); await f.ingest("memory auto enable");
  await f.ingest("我偏好简短回答"); assert.equal(inputs.length, 0);
  await f.memory.tick(); assert.deepEqual(inputs, ["我偏好简短回答"]);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-1", status: "failed" } } });
  await f.ingest("new"); await f.ingest("如何回答");
  assert.match(JSON.stringify(f.turnInputs.at(-1)!.additionalContext), /简短回答/);
  await f.memory.tick(); assert.equal(inputs.length, 1);
});

test("a corrected fact reaches another session, and an unrelated task receives no irrelevant memory", async t => {
  const f = fixture(t); await f.ingest("memory enable"); await f.ingest("memory remember 我喜欢米饭");
  await f.ingest("memory show"); const old = JSON.parse(f.sent.at(-1)!).memories[0];
  await f.ingest("new"); const threadId = f.state.getBinding(1000)!.threadId;
  const identity = JSON.stringify(f.store.thread(threadId));
  await f.ingest(`memory correct ${old.id} ${old.revision} 我不喜欢米饭`);
  assert.match(f.sent.at(-1)!, /已纠正/);
  await f.ingest("晚饭吃什么"); assert.match(JSON.stringify(f.turnInputs[0]!.additionalContext), /我不喜欢米饭/);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "failed" } } });
  await f.ingest("解释数据库事务"); assert.deepEqual(f.turnInputs[1]!.additionalContext, {});
  assert.equal(JSON.stringify(f.store.thread(threadId)), identity);
});

test("forget controls remove memory from a later Bridge session without changing role identity", async t => {
  const f = fixture(t); await f.ingest("memory enable"); await f.ingest("memory remember 我喜欢米饭");
  await f.ingest("memory show"); const old = JSON.parse(f.sent.at(-1)!).memories[0];
  await f.ingest(`memory forget ${old.id} ${old.revision}`); assert.match(f.sent.at(-1)!, /原始对话.*未删除/);
  await f.ingest("new"); const threadId = f.state.getBinding(1000)!.threadId;
  await f.ingest("晚饭吃什么"); assert.deepEqual(f.turnInputs[0]!.additionalContext, {});
  assert.equal(f.store.thread(threadId)!.profile.persona.name, "电脑管家");
});

test("private controls create a fresh thread with neither memory reads nor writes, and new restores ordinary behavior", async t => {
  const f = fixture(t); await f.ingest("memory enable"); await f.ingest("memory remember 我喜欢米饭");
  await f.ingest("memory private"); const privateId = f.state.getBinding(1000)?.threadId;
  assert.ok(privateId); assert.notEqual(privateId, "legacy"); assert.match(f.sent.at(-1)!, /无记忆临时会话/);
  await f.ingest("晚饭吃什么"); assert.deepEqual(f.turnInputs[0]!.additionalContext, {});
  assert.equal(f.memory.mayBackfill(privateId!, "4"), false);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: privateId, turn: { id: "turn-1", status: "failed" } } });
  await f.ingest("memory remember 我喜欢面条"); assert.match(f.sent.at(-1)!, /临时会话/);
  await f.ingest("new"); await f.ingest("晚饭吃什么");
  assert.match(JSON.stringify(f.turnInputs[1]!.additionalContext), /米饭/);
  assert.doesNotMatch(JSON.stringify(f.turnInputs[1]!.additionalContext), /面条/);
});

test("a queued message accepted while disabled cannot read or write memory after re-enable", async t => {
  const f = fixture(t); await f.ingest("memory enable"); await f.ingest("memory remember 我喜欢米饭");
  await f.ingest("开始任务"); await f.ingest("memory disable"); await f.ingest("我喜欢面条");
  await f.ingest("memory enable");
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-1", status: "failed" } } });
  assert.equal(f.turnInputs[1]!.text, "我喜欢面条"); assert.deepEqual(f.turnInputs[1]!.additionalContext, {});
  assert.equal(f.memory.mayBackfill("legacy", "5"), false);
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-2", status: "failed" } } });
  await f.ingest("晚饭吃什么"); assert.match(JSON.stringify(f.turnInputs[2]!.additionalContext), /米饭/);
  assert.doesNotMatch(JSON.stringify(f.turnInputs[2]!.additionalContext), /面条/);
});

test("Bridge preview and confirmation backfill proven original history for a later session", async t => {
  let reads = 0;
  const f = fixture(t, undefined, { async extract(input) { return { facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: input.evidence[0]!.text }] }; } }, { async read(id) {
    reads++; assert.equal(id, "legacy");
    return { data: [{ id: "turn-1", status: "failed", items: [{ type: "userMessage", content: [{ type: "text", text: "我喜欢米饭" }] }, { type: "agentMessage", text: "他人喜欢咖啡" }] }], nextCursor: null };
  } });
  await f.ingest("memory enable"); await f.ingest("我喜欢米饭");
  await f.bridge.ingestCodexEvent({ method: "turn/completed", params: { threadId: "legacy", turn: { id: "turn-1", status: "failed" } } });
  assert.equal(reads, 0); await f.ingest("memory backfill preview legacy");
  const preview = JSON.parse(f.sent.at(-1)!); assert.equal(preview.threads[0].verifiedMessages, 1);
  await f.ingest(`memory backfill start ${preview.confirmationCode}`); await f.memory.tick();
  await f.ingest("new"); await f.ingest("晚饭吃什么");
  assert.match(JSON.stringify(f.turnInputs.at(-1)!.additionalContext), /米饭/);
  assert.doesNotMatch(JSON.stringify(f.turnInputs.at(-1)!.additionalContext), /咖啡/);
});
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

test("live and queued WeChat messages deliver scene preferences through the actual turn input without rewriting user text",async t=>{
 const f=fixture(t,undefined,undefined,undefined,true);await f.ingest("config set name 合成角色");await f.ingest("memory enable");await f.ingest("memory remember 我希望你回复甜一些，语气幽默一些");
 await f.ingest("你怎么看这个安排？");assert.equal(f.turnInputs[0]!.text,"你怎么看这个安排？");assert.equal(f.turnInputs[0]!.additionalContext!["ilink.expression"]!.kind,"application");assert.match(f.turnInputs[0]!.additionalContext!["ilink.expression"]!.value,/温暖=4\/5.*幽默=3\/5/);assert.equal(f.turnInputs[0]!.additionalContext!["ilink.channel-memory"]!.kind,"untrusted");
 await f.ingest("直接给结果，取消执行了吗？");assert.equal(f.turnInputs.length,1);
 await f.bridge.ingestCodexEvent({method:"turn/completed",params:{threadId:"legacy",turn:{id:"turn-1",status:"failed"}}});
 assert.equal(f.turnInputs[1]!.text,"直接给结果，取消执行了吗？");assert.match(f.turnInputs[1]!.additionalContext!["ilink.expression"]!.value,/幽默=0\/5/);
});

test("the same-generation expression contract reaches live and queued turns and never rewrites the delivered facts",async t=>{
 const f=fixture(t,undefined,undefined,undefined,true);
 await f.ingest("config set humor 3");await f.ingest("config set tsundere 4");await f.ingest("new");const id=f.state.getBinding(1000)!.threadId,snapshot=JSON.stringify(f.store.thread(id));
 const explain="解释代码缓存的原理，保持自己的语气";await f.ingest(explain);
 const first=JSON.parse(f.turnInputs[0]!.additionalContext!["ilink.expression"]!.value);
 assert.equal(first.version,2);assert.equal(first.kind,"constraints-only");assert.equal(first.sceneHint,"explain");assert.equal(first.constraint,"contextual");assert.equal(first.limits.humor,3);assert.ok(first.postures.includes("mock-reluctance"));
 await f.ingest("直接给结果，取消执行了吗？");assert.equal(f.turnInputs.length,1);
 await f.bridge.ingestCodexEvent({method:"turn/completed",params:{threadId:id,turn:{id:"turn-1",status:"failed"}}});
 const queued=JSON.parse(f.turnInputs[1]!.additionalContext!["ilink.expression"]!.value);
 assert.equal(queued.constraint,"minimal");assert.deepEqual(queued.postures,["plain"]);assert.equal(queued.limits.humor,0);
 const final="尚未取消。未执行重启。等待审批；重试 2 次，返回 -7。路径 C:\\合成测试\\run.ts。";
 f.setFinal(id,"turn-2",final);await f.bridge.ingestCodexEvent({method:"turn/completed",params:{threadId:id,turn:{id:"turn-2",status:"completed"}}});
 assert.equal(f.sent.at(-1),final);assert.equal(f.turnInputs[0]!.text,explain);assert.equal(JSON.stringify(f.store.thread(id)),snapshot);
});
