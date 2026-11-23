import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { ChannelMemory } from "../src/memory/channel-memory.ts";

test("previewed owned history backfills only proven original messages, and pause/reopen/resume preserves the cursor", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-backfill-")); let accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.register("second", "b", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("primary", "a2"); accounts.claimThread("second", "b1");
  const reads: Array<string | undefined> = [], modelInputs: string[] = [];
  const user = (id: string, text: string) => ({ id, status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text }] }, { type: "agentMessage", text: "外部参考与助手复述不提炼" }] });
  const options = { now: () => 1000, extractor: { async extract(input: { evidence: Array<{ id: string; text: string }> }) { modelInputs.push(input.evidence[0]!.text); return { facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: input.evidence[0]!.text }] }; } }, historyReader: { async read(threadId: string, cursor?: string) {
    assert.equal(threadId, "a1"); reads.push(cursor);
    return cursor ? { data: [user("t2", "我喜欢面条"), user("unknown", "我喜欢别人的咖啡")], nextCursor: null } : { data: [user("t1", "我喜欢米饭"), user("too-new", "我喜欢新来的糕点")], nextCursor: "page-2" };
  } } };
  let memory = new ChannelMemory(accounts, "primary", options);
  const source = { threadId: "a1", messageId: "m1", kind: "channel-original" as const, nowMs: 1 };
  await memory.command("memory enable", source);
  memory.recordTurn({ ...source, text: "我喜欢米饭" }, "t1");
  memory.recordTurn({ ...source, messageId: "m2", text: "我喜欢面条" }, "t2");
  await memory.tick(); assert.equal(reads.length, 0);
  const preview = JSON.parse(await memory.command("memory backfill preview a1", source));
  assert.equal(preview.threads.length, 1); assert.equal(preview.threads[0].verifiedMessages, 2);
  memory.recordTurn({ ...source, messageId: "late", text: "我喜欢新来的糕点" }, "too-new");
  assert.match(await memory.command(`memory backfill start ${preview.confirmationCode}`, source), /已开始/);
  await memory.tick(); assert.deepEqual(reads, [undefined]); assert.match(JSON.stringify(memory.context("a2")), /米饭/);
  await memory.command("memory backfill pause", source); await memory.tick(); assert.equal(reads.length, 1);
  accounts.close(); accounts = new AccountStore(root); memory = new ChannelMemory(accounts, "primary", options);
  await memory.command("memory backfill resume", source); await memory.tick();
  assert.deepEqual(reads, [undefined, "page-2"]); assert.deepEqual(modelInputs.sort(), ["我喜欢米饭", "我喜欢面条"].sort());
  assert.doesNotMatch(JSON.stringify(memory.context("a2")), /咖啡|外部参考/);
  assert.equal(JSON.parse(await memory.command("memory backfill status", source)).jobs[0].status, "complete");
});

test("long history stops at its page budget and unknown provenance never enters the model", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-backfill-budget-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.register("second", "b", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("second", "b1");
  let reads = 0, calls = 0;
  const memory = new ChannelMemory(accounts, "primary", { now: () => 1000, extractor: { async extract() { calls++; return { facts: [] }; } }, historyReader: { async read() {
    reads++; return { data: [{ id: `unknown-${reads}`, status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "我喜欢别人的咖啡" }] }] }], nextCursor: reads < 12 ? `cursor-${reads}` : null };
  } } });
  const source = { threadId: "a1", messageId: "m", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source);
  assert.match(await memory.command("memory backfill preview b1", source), /不属于/);
  assert.match(await memory.command("memory backfill preview desktop", source), /不属于/);
  const preview = JSON.parse(await memory.command("memory backfill preview a1", source));
  await memory.command(`memory backfill start ${preview.confirmationCode}`, source);
  for (let i = 0; i < 12; i++) await memory.tick();
  assert.equal(reads, 10); assert.equal(calls, 0);
  assert.equal(JSON.parse(await memory.command("memory backfill status", source)).jobs[0].status, "limited");
  await memory.command("memory backfill resume", source); await memory.tick(); await memory.tick();
  assert.equal(reads, 12); assert.equal(calls, 0);
  const state = JSON.parse(await memory.command("memory backfill status", source)).jobs[0];
  assert.equal(state.status, "complete"); assert.equal(state.skipped, 12);
});

test("ownership changing during a history read quarantines the result before extraction or injection", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-backfill-owner-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.register("second", "b", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("primary", "a2");
  let finish: ((value: { data: unknown[]; nextCursor: null }) => void) | undefined, calls = 0;
  const memory = new ChannelMemory(accounts, "primary", { now: () => 1000, extractor: { async extract() { calls++; return { facts: [] }; } }, historyReader: { read: () => new Promise(resolve => { finish = resolve; }) } });
  const source = { threadId: "a1", messageId: "m1", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source); memory.recordTurn({ ...source, text: "我喜欢米饭" }, "t1");
  await memory.command("memory remember 我喜欢面条", { ...source, messageId: "explicit" });
  const preview = JSON.parse(await memory.command("memory backfill preview a1", source));
  await memory.command(`memory backfill start ${preview.confirmationCode}`, source); const pending = memory.tick();
  accounts.database.prepare("UPDATE thread_accounts SET account_name='second' WHERE thread_id='a1'").run();
  finish!({ data: [{ id: "t1", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "我喜欢米饭" }] }] }], nextCursor: null });
  await pending; assert.equal(calls, 0); assert.deepEqual(memory.context("a2"), {});
  const state = JSON.parse(await memory.command("memory backfill status", { ...source, threadId: "a2" })).jobs[0];
  assert.equal(state.status, "quarantined");
  accounts.database.prepare("UPDATE thread_accounts SET account_name='primary' WHERE thread_id='a1'").run();
  assert.deepEqual(memory.context("a2"), {}, "restoring an ownership label cannot silently revive quarantined evidence");
});
