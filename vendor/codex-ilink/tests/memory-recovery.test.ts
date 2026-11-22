import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { ChannelMemory } from "../src/memory/channel-memory.ts";
import { createChannelMemory, v2AccountEnabled } from "../src/memory/service.ts";
import { BridgeEngine } from "../src/bridge/bridge.ts";
import { AccountLeaseStore } from "../src/accounts/account-scope.ts";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import { backup } from "node:sqlite";
import { ProfileStore } from "../src/profiles/profile-store.ts";
import { defaultProfile } from "../src/profiles/profile.ts";

test("a corrupted pending extraction cannot replace its original evidence before a model call", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-corrupt-job-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let calls = 0;
  const memory = new ChannelMemory(accounts, "primary", { extractor: { async extract(input) { calls++; return { facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: input.evidence[0]!.text }] }; } } });
  const source = { threadId: "a1", messageId: "m1", kind: "channel-original" as const, nowMs: 1, text: "我喜欢米饭" };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source); memory.recordTurn(source, "t1");
  accounts.database.prepare("UPDATE memory_extraction_jobs SET body='我喜欢咖啡' WHERE account='primary'").run();
  await memory.tick(); assert.equal(calls, 0); assert.deepEqual(memory.context("a1"), {});
});

test("unavailable extension startup still dispatches an ordinary Bridge task with an explicit fault marker", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-fallback-")); const accounts = new AccountStore(root);
  accounts.register("primary", "alice", "bot-a"); accounts.claimThread("primary", "a1");
  const state = accounts.openState("primary"), leases = new AccountLeaseStore(join(root, "state.sqlite"), accounts, "primary");
  t.after(() => { leases.close(); state.close(); accounts.close(); rmSync(root, { recursive: true, force: true }); });
  state.bindController({ accountId: "bot-a", userId: "alice", boundAtMs: 1 }); state.setMainThreadId("a1");
  accounts.database.exec("CREATE TABLE channel_memories(account TEXT PRIMARY KEY) STRICT");
  const started: Array<Parameters<CodexRuntime["startTurn"]>[0]> = [];
  const bridge = new BridgeEngine({ memory: createChannelMemory(accounts, "primary"), state, leases, mainThreadId: "a1", bridgeInstanceId: "synthetic-host", newId: () => crypto.randomUUID(), now: () => 1000,
    session: { botId: "bot-a", controllerUserId: "alice", botToken: "fake", baseUrl: "https://example.invalid" },
    ilink: { async sendText(input) { return { accepted: true, clientId: input.clientId }; } },
    codex: { async ensureThread() {}, async startTurn(input) { started.push(input); return { turn: { id: "t1" } }; } },
  });
  await bridge.ingestBatch({ cursor: "1", messages: [{ message_id: 1, from_user_id: "alice", context_token: "c1", item_list: [{ type: 1, text_item: { text: "普通任务" } }] }] });
  assert.equal(started[0]!.text, "普通任务"); assert.match(JSON.stringify(started[0]!.additionalContext), /unavailable/);
});

test("broken extension schema degrades without changing the original account store, and pilot scope defaults off", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-corrupt-memory-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  accounts.database.exec("CREATE TABLE channel_memories(account TEXT PRIMARY KEY) STRICT");
  const memory = createChannelMemory(accounts, "primary");
  assert.equal(memory.snapshot().unavailable, true);
  assert.match(await memory.command("memory status", { threadId: "a1", messageId: "m", nowMs: 1 }), /不可用/);
  assert.equal(accounts.explicitOwner("a1"), "primary"); assert.equal(accounts.list().length, 1);
  assert.equal(v2AccountEnabled({}, "primary"), false);
  assert.equal(v2AccountEnabled({ ILINK_V2_ACCOUNTS: "primary" }, "primary"), true);
  assert.equal(v2AccountEnabled({ ILINK_V2_ACCOUNTS: "primary" }, "second"), false);
  assert.equal(v2AccountEnabled({ ILINK_V2_ACCOUNTS: "primary,*" }, "primary"), false);
});

test("a damaged fact fails closed in its channel while another channel still retrieves its own memory", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-integrity-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.register("second", "b", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("second", "b1");
  const a = new ChannelMemory(accounts, "primary"), b = new ChannelMemory(accounts, "second");
  const source = { threadId: "a1", messageId: "m", nowMs: 1, kind: "channel-original" as const };
  await a.command("memory enable", source); await a.command("memory remember 我喜欢米饭", source);
  await b.command("memory enable", { ...source, threadId: "b1" }); await b.command("memory remember 我喜欢面条", { ...source, threadId: "b1" });
  accounts.database.prepare("UPDATE channel_memories SET content='我喜欢被损坏的数据' WHERE account='primary'").run();
  assert.throws(() => a.context("a1"), /INTEGRITY/);
  assert.match(JSON.stringify(b.context("b1")), /面条/); assert.doesNotMatch(JSON.stringify(b.context("b1")), /被损坏/);
});

test("concurrent worker ticks share a claim, and the persisted daily budget bounds extraction calls", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-cost-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let now = 1000, calls = 0;
  const memory = new ChannelMemory(accounts, "primary", { now: () => now, extractor: { async extract() { calls++; return { facts: [] }; } } });
  const source = { threadId: "a1", messageId: "m", kind: "channel-original" as const, nowMs: 1 };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  for (let i = 0; i < 60; i++) memory.recordTurn({ ...source, messageId: `m-${i}`, text: `我喜欢第${i}种水果` }, `t-${i}`);
  await Promise.all(Array.from({ length: 10 }, () => memory.tick())); assert.equal(calls, 1);
  for (let i = 0; i < 70; i++) await memory.tick();
  assert.equal(calls, 50); assert.equal(JSON.parse(await memory.command("memory auto status", source)).callsToday, 50);
  now += 86400000;
  for (let i = 0; i < 10; i++) await memory.tick(); assert.equal(calls, 60);
});

test("an extraction deadline aborts once and a late model result cannot revive a suspended job", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-timeout-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let finish: (() => void) | undefined, calls = 0, aborted = false;
  const memory = new ChannelMemory(accounts, "primary", { extractionTimeoutMs: 5, extractor: { extract: input => {
    calls++; input.signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(resolve => { finish = () => resolve({ facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: input.evidence[0]!.text }] }); });
  } } });
  const source = { threadId: "a1", messageId: "m", kind: "channel-original" as const, nowMs: 1, text: "我喜欢米饭" };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source); memory.recordTurn(source, "t1");
  await memory.tick(); assert.equal(aborted, true);
  finish!(); await Promise.resolve(); await memory.tick();
  assert.equal(calls, 1); assert.deepEqual(memory.context("a1"), {});
  assert.ok(JSON.parse(await memory.command("memory auto status", source)).jobs.some((j: { status: string }) => j.status === "unknown"));
});

test("isolated pilot backup and rollback preserve binding, profile data and frozen v1 identity", async t => {
  const container = mkdtempSync(join(tmpdir(), "ilink-pilot-rollback-")), sourceRoot = join(container, "source"), restoredRoot = join(container, "restored");
  const accounts = new AccountStore(sourceRoot); let restored: AccountStore | undefined;
  const state = accounts.openState("primary");
  t.after(() => { restored?.close(); state.close(); accounts.close(); rmSync(container, { recursive: true, force: true }); });
  accounts.register("primary", "alice", "bot-a"); accounts.claimThread("primary", "main"); accounts.claimThread("primary", "selected");
  state.bindController({ accountId: "bot-a", userId: "alice", boundAtMs: 1 }); state.setMainThreadId("main");
  state.setBindingForNavigation({ threadId: "selected", projectPath: null, updatedAtMs: 1000, expiresAtMs: 5000 });
  const profiles = new ProfileStore(accounts.database, sourceRoot); const p = defaultProfile(); p.persona.name = "合成旧角色";
  const profile = profiles.save("primary", p);
  profiles.snapshot({ account: "primary", threadId: "selected", profile, instructions: "合成v1冻结指令", compilerVersion: 1, model: "synthetic-model", effort: "low", cwd: "synthetic-workspace" });
  const before = profiles.thread("selected"), hash = profiles.current("primary")!.hash;
  mkdirSync(restoredRoot); await backup(accounts.database, join(restoredRoot, "state.sqlite"));
  cpSync(join(sourceRoot, "profiles"), join(restoredRoot, "profiles"), { recursive: true });
  const memory = createChannelMemory(accounts, "primary");
  await memory.command("memory enable", { threadId: "main", messageId: "enable", nowMs: 1 });
  await memory.command("memory remember 我喜欢米饭", { threadId: "main", messageId: "fact", nowMs: 2, kind: "channel-original" });
  await memory.command("memory disable", { threadId: "main", messageId: "disable", nowMs: 3 });
  assert.equal(v2AccountEnabled({}, "primary"), false);
  assert.equal(state.getBinding(1000)!.threadId, "selected"); assert.equal(profiles.current("primary")!.hash, hash); assert.deepEqual(profiles.thread("selected"), before);
  restored = new AccountStore(restoredRoot); const restoredProfiles = new ProfileStore(restored.database, restoredRoot), restoredState = restored.openState("primary");
  try { assert.equal(restoredState.getBinding(1000)!.threadId, "selected"); assert.equal(restoredState.getBridgeSettings().mainThreadId, "main"); assert.deepEqual(restoredProfiles.thread("selected"), before); assert.equal(restoredProfiles.load("primary").persona.name, "合成旧角色"); }
  finally { restoredState.close(); }
});

test("older relevant facts survive unrelated traffic and complete review remains available through export pages", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-retrieval-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  const memory = new ChannelMemory(accounts, "primary"), source = { threadId: "a1", messageId: "food", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source); await memory.command("memory remember 我喜欢米饭", source);
  for (let i = 0; i < 110; i++) await memory.command(`memory remember 我偏好第${i}种事务解释`, { ...source, messageId: `unrelated-${i}`, nowMs: i + 2 });
  assert.match(JSON.stringify(memory.context("a1", "晚饭吃什么")), /米饭/);
  assert.match(JSON.stringify(memory.context("a1", "记得我的饮食偏好吗，晚饭吃什么")), /米饭/);
  let cursor: string | null = "", total = 0;
  do { const page = JSON.parse(await memory.command(`memory export${cursor ? ` ${cursor}` : ""}`, source)); total += page.memories.length; cursor = page.nextCursor; } while (cursor);
  assert.equal(total, 111);
});
