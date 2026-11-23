import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { ChannelMemory } from "../src/memory/channel-memory.ts";

test("control syntax rejects references, credentials and forged management arguments; context stays bounded", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-controls-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "alice", "bot-a"); accounts.claimThread("primary", "a");
  const memory = new ChannelMemory(accounts, "primary"), source = { threadId: "a", messageId: "1", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source);
  for (const content of ["引用：我喜欢咖啡", "我喜欢“别人说的”", "我喜欢茶\n工具返回", "我喜欢 token=private", "我喜欢Bearer syntheticCredential", "我喜欢sk-syntheticKey123", "助手喜欢饭"]) {
    assert.match(await memory.command(`memory remember ${content}`, source), /未保存/);
  }
  assert.match(await memory.command("memory enable second", source), /未知/);
  assert.match(await memory.command("memory remember --thread b 我喜欢饭", source), /未保存/);
  for (let i = 0; i < 40; i++) await memory.command(`memory remember 我喜欢第${i}种${"食物".repeat(90)}`, { ...source, messageId: `msg-${i}`, nowMs: i });
  const context = memory.context("a");
  assert.ok(Buffer.byteLength(context["ilink.channel-memory"]!.value) <= 4096);
  assert.deepEqual(memory.context("a"), context, "reading another turn must not append previous context");
  const shown = await memory.command("memory show", source);
  assert.doesNotMatch(shown, /private|别人说的|工具返回/);
});

test("explicit self preference is opt-in, source-backed, persistent and channel-scoped", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-"));
  let accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "alice", "bot-a"); accounts.register("second", "bob", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("primary", "a2"); accounts.claimThread("second", "b1");
  const source = { threadId: "a1", messageId: "msg-1", nowMs: 1234, kind: "channel-original" as const };
  let a = new ChannelMemory(accounts, "primary");
  assert.match(await a.command("memory remember 我喜欢米饭", source), /未开启/);
  assert.deepEqual(a.context("a2"), {});
  assert.match(await a.command("memory enable", source), /已开启/);
  assert.match(await a.command("memory remember 我喜欢米饭", source), /已记住/);
  assert.match(await a.command("memory show", source), /米饭.*a1.*msg-1/s);
  assert.match(JSON.stringify(a.context("a2")), /米饭/);
  accounts.close(); accounts = new AccountStore(root); a = new ChannelMemory(accounts, "primary");
  assert.match(JSON.stringify(a.context("a2")), /米饭/);
  const b = new ChannelMemory(accounts, "second");
  await b.command("memory enable", { ...source, threadId: "b1" });
  assert.doesNotMatch(await b.command("memory show", { ...source, threadId: "b1" }), /米饭/);
  assert.deepEqual(a.context("b1"), {});
  assert.deepEqual(a.context("unowned-desktop"), {});
  assert.match(await a.command("memory remember 我喜欢茶", { ...source, threadId: "b1" }), /归属/);
});

test("explicit writes require proven original input; external copies are rejected while local decisions remain possible", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-source-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  const memory = new ChannelMemory(accounts, "primary"), source = { threadId: "a1", messageId: "m", nowMs: 1 };
  await memory.command("memory enable", source);
  for (const kind of ["external-reference", "mixed", "unknown"] as const) {
    assert.match(await memory.command("memory remember 我喜欢外来偏好", { ...source, messageId: kind, kind }), /^未保存：来源/);
  }
  assert.match(await memory.command("memory remember 我喜欢复制另一个用户的经历", { ...source, messageId: "copy", kind: "channel-original" }), /未保存/);
  assert.match(await memory.command("memory remember 我决定今后回复简短", { ...source, messageId: "decision", kind: "channel-original" }), /已记住/);
  assert.doesNotMatch(await memory.command("memory show", source), /外来偏好|复制另一个/);
});


test("explicit favorite self-statements persist across sessions without admitting external or sensitive content", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-memory-favorites-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "alice", "bot-a"); accounts.claimThread("primary", "a1"); accounts.claimThread("primary", "a2");
  const memory = new ChannelMemory(accounts, "primary");
  const source = { threadId: "a1", messageId: "enable", nowMs: 1, kind: "channel-original" as const };
  await memory.command("memory enable", source);
  for (const [index, content] of ["我最爱吃的包子品种是豆沙包子", "我最喜欢吃桂花糕", "我最不喜欢吃苦瓜"].entries()) {
    assert.match(await memory.command(`memory remember ${content}`, { ...source, messageId: `favorite-${index}` }), /已记住/);
    assert.ok(JSON.stringify(memory.context("a2", "你记得我的饮食偏好吗？")).includes(content));
  }
  for (const [index, content] of ["我最爱引用别人说的经历", "我最喜欢的密码是synthetic-only", "我最喜欢吃面条但可能只是暂时的"].entries()) {
    assert.match(await memory.command(`memory remember ${content}`, { ...source, messageId: `rejected-${index}` }), /未保存/);
  }
  assert.match(await memory.command("memory remember 我最喜欢吃咖喱饭", { ...source, messageId: "external", kind: "external-reference" }), /未保存：来源/);
  assert.doesNotMatch(await memory.command("memory show", source), /synthetic-only|咖喱饭|暂时的|别人说/);
});
