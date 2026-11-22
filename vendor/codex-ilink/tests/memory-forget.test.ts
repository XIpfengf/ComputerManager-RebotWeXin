import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { ChannelMemory } from "../src/memory/channel-memory.ts";

test("forgotten memory stays absent after paraphrased extraction and reopen, while another channel is unchanged", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-forget-")); let accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.register("second", "b", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("primary", "a2"); accounts.claimThread("second", "b1");
  let calls = 0;
  const extractor = { async extract(input: { evidence: Array<{ id: string; text: string }> }) { calls++; return { facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: input.evidence[0]!.text }] }; } };
  let memory = new ChannelMemory(accounts, "primary", { extractor });
  const source = { threadId: "a1", messageId: "old", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  await memory.command("memory remember 我偏好简短回答", source);
  const b = new ChannelMemory(accounts, "second");
  await b.command("memory enable", { ...source, threadId: "b1" }); await b.command("memory remember 我偏好简短回答", { ...source, threadId: "b1" });
  const old = JSON.parse(await memory.command("memory show", source)).memories[0];
  assert.match(await memory.command(`memory forget ${old.id} ${old.revision}`, { ...source, messageId: "forget", nowMs: 2 }), /已遗忘.*原始对话/s);
  assert.deepEqual(memory.context("a2"), {});
  assert.doesNotMatch(await memory.command(`memory source ${old.id}`, source), /我偏好简短回答/);
  assert.match(await b.command("memory show", { ...source, threadId: "b1" }), /简短回答/);
  accounts.close(); accounts = new AccountStore(root); memory = new ChannelMemory(accounts, "primary", { extractor });
  memory.recordTurn({ ...source, messageId: "paraphrase", text: "我偏好简洁回复" }, "new-turn");
  memory.recordTurn({ ...source, messageId: "unknown-paraphrase", text: "我希望你少说两句" }, "other-turn");
  await memory.tick(); await memory.tick();
  assert.equal(calls, 0); assert.deepEqual(memory.context("a2"), {});
  assert.match(await memory.command("memory remember 我希望回复简短", { ...source, messageId: "new-explicit", nowMs: 3 }), /已记住/);
  assert.match(JSON.stringify(memory.context("a2")), /我希望回复简短/);
});

test("forgetting fences an in-flight extraction and transaction failures preserve the original memory", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-forget-race-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let finish: (() => void) | undefined;
  const memory = new ChannelMemory(accounts, "primary", { extractor: { extract: input => new Promise(resolve => { finish = () => resolve({ facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: input.evidence[0]!.text }] }); }) } });
  const source = { threadId: "a1", messageId: "old", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  await memory.command("memory remember 我喜欢米饭", source);
  const old = JSON.parse(await memory.command("memory show", source)).memories[0];
  // Storage failure injection at the documented persistence seam, not a private-function assertion.
  accounts.database.exec("CREATE TEMP TRIGGER simulate_forget_failure BEFORE INSERT ON memory_tombstones BEGIN SELECT RAISE(ABORT,'synthetic-forget-failure'); END;");
  await assert.rejects(memory.command(`memory forget ${old.id} ${old.revision}`, { ...source, messageId: "forget-failed" }), /synthetic-forget-failure/);
  assert.match(JSON.stringify(memory.context("a1")), /米饭/);
  accounts.database.exec("DROP TRIGGER simulate_forget_failure");
  memory.recordTurn({ ...source, messageId: "pending", text: "我喜欢白米饭" }, "t1");
  const pending = memory.tick();
  assert.match(await memory.command(`memory forget ${old.id} ${old.revision}`, { ...source, messageId: "forget", nowMs: 2 }), /已遗忘/);
  finish!(); await pending;
  assert.deepEqual(memory.context("a1"), {});
  assert.doesNotMatch(await memory.command("memory profile", source), /白米饭|我喜欢米饭/);
  assert.match(await memory.command(`memory forget ${old.id} ${old.revision}`, { ...source, messageId: "stale" }), /修订|已经遗忘/);
});
