import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { ChannelMemory } from "../src/memory/channel-memory.ts";
import { ExtractionFailure } from "../src/memory/extraction.ts";

test("automatic extraction runs off the reply path and commits only original source-backed user facts once", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-extract-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1"); accounts.claimThread("primary", "a2");
  let calls = 0;
  const memory = new ChannelMemory(accounts, "primary", { extractor: { async extract(input) {
    calls++;
    assert.deepEqual(input.evidence.map(e => e.text), ["我偏好简短回答"]);
    return { facts: [{ sourceId: input.evidence[0]!.id, subject: "user", category: "preference", content: "我偏好简短回答" }] };
  } } });
  const source = { threadId: "a1", messageId: "m1", kind: "channel-original" as const, nowMs: 1, text: "我偏好简短回答" };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  memory.recordTurn(source, "turn-1"); memory.recordTurn(source, "turn-1");
  assert.equal(calls, 0); assert.deepEqual(memory.context("a2"), {});
  await memory.tick();
  assert.match(JSON.stringify(memory.context("a2")), /简短回答/);
  await memory.tick(); assert.equal(calls, 1);
});

test("foreign results, transient jokes and stale policy results never become facts; known failures back off", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-extract-invalid-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let now = 1000, calls = 0;
  const memory = new ChannelMemory(accounts, "primary", { now: () => now, extractor: { async extract() { calls++; return { facts: [{ sourceId: "foreign", subject: "user", category: "preference", content: "我喜欢茶" }] }; } } });
  const source = { threadId: "a1", messageId: "m1", kind: "channel-original" as const, nowMs: 1, text: "我喜欢茶" };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  for (const [i, text] of ["我今天很累", "我喜欢茶，开玩笑的", "我可能喜欢茶", "助手喜欢茶"].entries()) memory.recordTurn({ ...source, messageId: `joke-${i}`, text }, `t-${i}`);
  await memory.tick(); assert.equal(calls, 0);
  memory.recordTurn(source, "t1"); await memory.tick(); assert.equal(calls, 1); assert.deepEqual(memory.context("a1"), {});
  await memory.tick(); assert.equal(calls, 1);
  now += 60000; await memory.tick(); now += 120000; await memory.tick(); assert.equal(calls, 3);
  now += 999999; await memory.tick(); assert.equal(calls, 3);
  assert.match(await memory.command("memory auto status", source), /failed/);
});

test("a delayed result after disabling extraction is discarded, while explicit memory remains available", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-extract-delay-")); const accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let finish: ((value: unknown) => void) | undefined;
  const memory = new ChannelMemory(accounts, "primary", { extractor: { extract: () => new Promise(resolve => { finish = resolve; }) } });
  const source = { threadId: "a1", messageId: "m1", kind: "channel-original" as const, nowMs: 1, text: "我喜欢茶" };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  memory.recordTurn(source, "t1"); const pending = memory.tick();
  await memory.command("memory auto disable", source);
  finish!({ facts: [{ sourceId: "wechat:m1", subject: "user", category: "preference", content: "我喜欢茶" }] });
  await pending; assert.deepEqual(memory.context("a1"), {});
  assert.match(await memory.command("memory auto status", source), /invalidated/);
  assert.match(await memory.command("memory remember 我喜欢米饭", { ...source, messageId: "explicit" }), /已记住/);
});

test("unknown HTTP outcomes are suspended across state reopen and cannot silently incur another call", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-extract-unknown-")); let accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.claimThread("primary", "a1");
  let calls = 0;
  const extractor = { async extract() { calls++; throw new ExtractionFailure("unknown"); } };
  let memory = new ChannelMemory(accounts, "primary", { extractor });
  const source = { threadId: "a1", messageId: "m1", kind: "channel-original" as const, nowMs: 1, text: "我喜欢茶" };
  await memory.command("memory enable", source); await memory.command("memory auto enable", source);
  memory.recordTurn(source, "t1"); await memory.tick();
  accounts.close(); accounts = new AccountStore(root); memory = new ChannelMemory(accounts, "primary", { extractor });
  await memory.tick(); assert.equal(calls, 1);
  assert.match(await memory.command("memory auto status", source), /unknown/);
});
