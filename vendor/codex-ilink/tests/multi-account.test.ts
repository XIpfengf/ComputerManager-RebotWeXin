import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { scopedDatabase } from "../src/bridge/scoped-database.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { BridgeDaemon } from "../src/daemon/bridge-daemon.ts";
import { AccountStore } from "../src/accounts/account-store.ts";
import { accountCodex, AccountLeaseStore } from "../src/accounts/account-scope.ts";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import type {DelegationService} from "../src/delegation/delegation-service.ts";
import type { CodexEvent } from "../src/bridge/bridge.ts";
import type { ILinkSession, WireWeixinMessage } from "../src/ilink/protocol.ts";

test("delegation uses only the real active input after dispatch body is cleared",async()=>{
  const f=fixture();const listeners=new Set<(e:CodexEvent)=>void>();const responses:Array<Record<string,unknown>>=[];let sourceText="";
  const runtime={startTurn:async()=>({turn:{id:"test-turn"}}),onEvent:(fn:(e:CodexEvent)=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},isServerRequestLive:()=>true,respondToServerRequest:(_id:unknown,result:Record<string,unknown>)=>{responses.push(result);return true;}} as unknown as CodexRuntime;
  const service={command:async(_ctx:unknown,_args:unknown,source:{text:string})=>{sourceText=source.text;return "queued";}} as unknown as DelegationService;
  try{
    f.primary.createDispatchIntent({operationId:"op-delegate",dedupeKey:"test/delegate",threadId:"thread-a",body:"private original",createdAtMs:1,contextToken:"ctx"});
    f.primary.markDispatchAccepted("op-delegate","test-turn",2);assert.equal(f.primary.getDispatchIntentByTurnId("test-turn")?.body,null);
    const scoped=accountCodex(runtime,f.accounts,"primary",undefined,{service,state:f.primary});scoped.onEvent(()=>{});
    await scoped.startTurn({threadId:"thread-a",text:"告诉验收会话执行测试",clientUserMessageId:"msg"});
    for(const fn of listeners)fn({id:1,method:"item/tool/call",params:{threadId:"thread-a",turnId:"test-turn",namespace:null,tool:"delegate_task",arguments:{action:"submit"}}});
    await new Promise(r=>setImmediate(r));assert.equal(sourceText,"告诉验收会话执行测试");assert.equal(responses[0]?.success,true);
    for(const fn of listeners)fn({method:"turn/completed",params:{threadId:"thread-a",turn:{id:"test-turn"}}});
    for(const fn of listeners)fn({id:2,method:"item/tool/call",params:{threadId:"thread-a",turnId:"test-turn",namespace:null,tool:"delegate_task",arguments:{action:"submit"}}});
    await new Promise(r=>setImmediate(r));assert.equal(responses[1]?.success,false);
  }finally{f.close();}
});

function fixture() {
  const root = join(mkdtempSync(join(tmpdir(), "ilink-accounts-")), "Codex_iLink");
  const primary = new SqliteState(join(root, "state.sqlite"));
  primary.bindController({ accountId: "bot-a", userId: "user-a", boundAtMs: 1 });
  primary.saveILinkSession({ botId: "bot-a", controllerUserId: "user-a", baseUrl: "https://a.example", protectedToken: "protected-a" });
  primary.setMainThreadId("thread-a");
  const accounts = new AccountStore(root);
  accounts.importPrimary();
  const secondary = accounts.openState("secondary");
  secondary.bindController({ accountId: "bot-b", userId: "user-b", boundAtMs: 1 });
  secondary.saveILinkSession({ botId: "bot-b", controllerUserId: "user-b", baseUrl: "https://b.example", protectedToken: "protected-b" });
  accounts.register("secondary", "user-b", "bot-b");
  accounts.claimThread("secondary", "thread-b");
  const leasesA = new AccountLeaseStore(join(root, "state.sqlite"), accounts, "primary");
  const leasesB = new AccountLeaseStore(join(root, "state.sqlite"), accounts, "secondary");
  return { root, primary, secondary, accounts, leasesA, leasesB, close() {
    leasesA.close(); leasesB.close(); primary.close(); secondary.close(); accounts.close(); rmSync(dirname(root), { recursive: true, force: true });
  } };
}

test("adding an account preserves original credentials, navigation and history identity", () => {
  const f = fixture();
  try {
    assert.equal(f.accounts.list().length, 2);
    assert.equal(f.primary.getILinkSession()?.protectedToken, "protected-a");
    assert.equal(f.primary.getBridgeSettings().mainThreadId, "thread-a");
    assert.equal(f.secondary.getBridgeSettings().mainThreadId, null);
    f.secondary.setMainThreadId("thread-b");
    assert.equal(f.primary.getBridgeSettings().mainThreadId, "thread-a");
    assert.throws(() => f.accounts.register("third", "user-a", "bot-c"));
    assert.throws(() => f.accounts.stateDirectory("../escape"));
    assert.throws(() => f.accounts.claimThread("secondary", "thread-a"), /OWNERSHIP/u);
    f.accounts.importPrimary();
    assert.equal(f.accounts.list().length, 2);
  } finally { f.close(); }
});

test("shared leases cannot be reconciled or released by the other account", () => {
  const f = fixture();
  try {
    const input = { owner: "bridge" as const, instanceId: "host", operationId: "op-a", threadId: "thread-a", turnId: null, createdAtMs: 10 };
    assert.equal(f.leasesA.tryAcquire(input).acquired, true);
    assert.equal(f.leasesB.listLeases().length, 0);
    assert.throws(() => f.leasesB.getLease("thread-a"), /OWNERSHIP/u);
    assert.throws(() => f.leasesB.release(input), /OWNERSHIP/u);
    assert.equal(f.leasesB.tryAcquire({ ...input, operationId: "op-b", threadId: "thread-b" }).acquired, true);
    assert.deepEqual(f.leasesA.listLeases().map(l => l.threadId), ["thread-a"]);
    assert.deepEqual(f.leasesB.listLeases().map(l => l.threadId), ["thread-b"]);
  } finally { f.close(); }
});

test("scoped schema preserves quoted values, foreign keys, version and rollback in one database", () => {
  const f = fixture();
  const raw = new DatabaseSync(join(f.root, "state.sqlite"));
  const scoped = scopedDatabase(raw, "secondary");
  try {
    assert.deepEqual(f.secondary.storageDiagnostics(), f.primary.storageDiagnostics());
    assert.equal(scoped.prepare("SELECT 'outbox', 'controller', 'it''s bindings' AS value").get()?.value, "it's bindings");
    const lease = { threadId: "thread-b", owner: "bridge" as const, instanceId: "host", operationId: "atomic-b", turnId: null, createdAtMs: 100 };
    f.leasesB.tryAcquire(lease);
    const before = f.secondary.getBridgeSettings().mainThreadId;
    scoped.exec("BEGIN IMMEDIATE");
    scoped.prepare("UPDATE bridge_settings SET main_thread_id='rollback-marker'").run();
    scoped.prepare("DELETE FROM turn_leases WHERE thread_id='thread-b'").run();
    scoped.exec("ROLLBACK");
    assert.equal(f.secondary.getBridgeSettings().mainThreadId, before);
    assert.equal(f.leasesB.getLease("thread-b")?.operationId, "atomic-b");
    assert.equal(f.primary.getBridgeSettings().mainThreadId, "thread-a");
    assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { scoped.close(); f.close(); }
});

test("runtime facade isolates thread navigation, mutations, events and approval callbacks", async () => {
  const f = fixture();
  const listeners = new Set<(e: CodexEvent) => void>();
  const responses: Array<number | string> = [];
  let closed = 0;
  const runtime = {
    async listThreads() { return { data: [{ id: "thread-a" }, { id: "thread-b" }, { id: "desktop-old" }], nextCursor: "next" }; },
    async startThread() { return { thread: { id: "new-b" } }; },
    async resumeThread(id: string) { return { thread: { id } }; },
    async interruptTurn() { return {}; },
    onEvent(fn: (e: CodexEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    isServerRequestLive() { return true; },
    respondToServerRequest(id: number | string) { responses.push(id); return true; },
    close() { closed++; },
  } as unknown as CodexRuntime;
  try {
    const a = accountCodex(runtime, f.accounts, "primary");
    const b = accountCodex(runtime, f.accounts, "secondary");
    assert.deepEqual((await b.listThreads()).data, [{ id: "thread-b" }]);
    assert.equal((await b.listThreads()).nextCursor, "next");
    assert.throws(() => b.resumeThread("thread-a"), /OWNERSHIP/u);
    assert.throws(() => a.interruptTurn({ threadId: "thread-b", turnId: "turn-b" }), /OWNERSHIP/u);
    await b.startThread("."); assert.equal(f.accounts.owner("new-b"), "secondary");
    const seenA: CodexEvent[] = [], seenB: CodexEvent[] = [];
    const offA = a.onEvent(e => seenA.push(e)), offB = b.onEvent(e => seenB.push(e));
    for (const fn of listeners) fn({ method: "item/commandExecution/requestApproval", id: 17, params: { threadId: "thread-b" } });
    assert.equal(seenA.length, 0); assert.equal(seenB.length, 1);
    assert.equal(a.respondToServerRequest(17, {}), false);
    assert.equal(b.respondToServerRequest(17, {}), true);
    assert.equal(b.respondToServerRequest(17, {}), false);
    assert.deepEqual(responses, [17]);
    for (const fn of listeners) fn({ method: "item/commandExecution/requestApproval", id: 18, params: {} });
    assert.equal(b.respondToServerRequest(18, {}), false);
    offA(); offB(); a.close(); b.close(); assert.equal(closed, 0);
  } finally { f.close(); }
});

test("secondary registered threads are guarded by the existing installed hook DB", () => {
  const f = fixture();
  try {
    f.primary.enableArbitration("host");
    f.leasesB.tryAcquire({ threadId: "thread-b", owner: "bridge", instanceId: "host", operationId: "op-b", turnId: null, createdAtMs: 10 });
    const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: dirname(f.root) };
    delete env.CODEX_ILINK_LEASE_DB;
    delete env.CODEX_ILINK_BRIDGE;
    const result = spawnSync(process.execPath, [resolve("plugins/codex-ilink-probe/scripts/turn-lifecycle-hook.mjs"), "UserPromptSubmit"], {
      encoding: "utf8", timeout: 10_000, env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "thread-b", turn_id: "desktop-b", cwd: f.root }),
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).stopReason, "CODEX_ILINK_THREAD_BUSY");
  } finally { f.close(); }
});

test("two real Daemons share a runtime while messages, cancellation and recovery remain account-local", async () => {
  const f = fixture();
  const listeners = new Set<(e: CodexEvent) => void>();
  const turns: Array<{ threadId: string; text: string }> = [];
  const interrupted: string[] = [];
  const sent: Array<{ account: string; token: string; context: string; text: string }> = [];
  const queue = new Map<string, WireWeixinMessage[]>();
  const threads = new Map<string, Record<string, unknown>>();
  const runtime = {
    onEvent(fn: (e: CodexEvent) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    close() { throw new Error("Account closed the shared runtime"); },
    async startThread() { throw new Error("Existing main thread should survive restart"); },
    async setThreadName() { return {}; },
    async resumeThread(id: string) { return { thread: { id }, cwd: f.root }; },
    async readThread({ threadId }: { threadId: string }) { return { thread: threads.get(threadId) ?? { id: threadId, turns: [], status: { type: "idle" } } }; },
    async startTurn(input: { threadId: string; text: string }) {
      turns.push(input);
      const leases = input.threadId === "thread-a" ? f.leasesA : f.leasesB;
      assert.equal(leases.claimBridgeTurn({ instanceId: "host", threadId: input.threadId, turnId: `turn-${input.threadId}` }), true);
      return { turn: { id: `turn-${input.threadId}` } };
    },
    async interruptTurn(input: { threadId: string }) { interrupted.push(input.threadId); return {}; },
  } as unknown as CodexRuntime;
  f.secondary.setMainThreadId("thread-b");
  const sessions: ILinkSession[] = [
    { botId: "bot-a", controllerUserId: "user-a", botToken: "token-a", baseUrl: "https://a.example" },
    { botId: "bot-b", controllerUserId: "user-b", botToken: "token-b", baseUrl: "https://b.example" },
  ];
  const makeMessage = (user: string, id: number, text: string): WireWeixinMessage => ({ message_id: id, from_user_id: user, context_token: `ctx-${user}-${id}`, item_list: [{ type: 1, text_item: { text } }] });
  let offlineB = false;
  const makeDaemon = (i: number) => {
    const session = sessions[i]!;
    return new BridgeDaemon({
      bridgeInstanceId: "host", codex: accountCodex(runtime, f.accounts, i ? "secondary" : "primary"),
      state: i ? f.secondary : f.primary, leases: i ? f.leasesB : f.leasesA, session,
      inboxDirectory: join(f.accounts.stateDirectory(i ? "secondary" : "primary"), "Inbox"),
      hookReceiver: { start: async () => {}, close: async () => {}, drainSpool: async () => 0 },
      newId: () => crypto.randomUUID(), now: () => 1_000,
      ilink: {
        async getUpdates(input) {
          assert.equal(input.session.botToken, session.botToken);
          if (i && offlineB) throw new Error("simulated B connection failure");
          const messages = queue.get(session.botId) ?? []; queue.set(session.botId, []);
          return { kind: "updates" as const, cursor: `cursor-${session.botId}`, messages };
        },
        async sendText(input) {
          sent.push({ account: input.session.botId, token: input.session.botToken, context: input.contextToken, text: input.text });
          return { accepted: true as const, clientId: input.clientId };
        },
      },
    });
  };
  let daemons = [makeDaemon(0), makeDaemon(1)];
  try {
    await Promise.all(daemons.map(d => d.start()));
    // Same message ID is valid in both channels. A third user cannot inject a turn.
    queue.set("bot-a", [makeMessage("intruder", 99, "ignored"), makeMessage("user-a", 7, "A task")]);
    queue.set("bot-b", [makeMessage("user-b", 7, "B task")]);
    await Promise.all(daemons.map(d => d.pollOnce()));
    assert.deepEqual(turns.map(t => [t.threadId, t.text]).sort(), [["thread-a", "A task"], ["thread-b", "B task"]]);
    assert.equal(f.primary.listInboundMessages().length, 1);
    assert.equal(f.secondary.listInboundMessages().length, 1);
    queue.set("bot-b", [makeMessage("user-b", 8, "stop")]);
    await daemons[1]!.pollOnce();
    assert.deepEqual(interrupted, ["thread-b"]);
    // Complete both active turns; event listeners must only deliver to their owner.
    for (const [id, answer] of [["thread-a", "ANSWER_A"], ["thread-b", "ANSWER_B"]]) {
      const turn = { id: `turn-${id}`, status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: answer }] };
      threads.set(id!, { id, turns: [turn], status: { type: "idle" } });
      for (const fn of listeners) fn({ method: "turn/completed", params: { threadId: id, turn } });
    }
    for (let i = 0; i < 100 && f.leasesA.listLeases().length + f.leasesB.listLeases().length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(f.leasesA.listLeases().length + f.leasesB.listLeases().length, 0);
    assert(sent.some(s => s.account === "bot-a" && s.text === "ANSWER_A" && s.token === "token-a"));
    assert(!sent.some(s => s.account === "bot-b" && s.text.includes("ANSWER_A")));
    assert(!sent.some(s => s.account === "bot-a" && s.text.includes("ANSWER_B")));
    assert(sent.every(s => s.context.startsWith(s.account === "bot-a" ? "ctx-user-a" : "ctx-user-b")));
    offlineB = true;
    await assert.rejects(daemons[1]!.pollOnce(), /simulated B/u);
    queue.set("bot-a", [makeMessage("user-a", 8, "help")]);
    assert.equal((await daemons[0]!.pollOnce()).accepted, 1);
    offlineB = false;
    await Promise.all(daemons.map(d => d.stop()));
    daemons = [makeDaemon(0), makeDaemon(1)];
    await Promise.all(daemons.map(d => d.start()));
    queue.set("bot-a", [makeMessage("user-a", 7, "A task")]);
    queue.set("bot-b", [makeMessage("user-b", 7, "B task")]);
    await Promise.all(daemons.map(d => d.pollOnce()));
    assert.equal(turns.length, 2, "Restart must not replay either user's input");
    assert.equal(f.primary.getBridgeSettings().mainThreadId, "thread-a");
    assert.equal(f.secondary.getBridgeSettings().mainThreadId, "thread-b");
  } finally {
    await Promise.all(daemons.map(d => d.stop()));
    f.close();
  }
});
