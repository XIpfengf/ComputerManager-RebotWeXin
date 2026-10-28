import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { formatWechatFinalReply, extractWechatLocalFileReferences } from "../src/bridge/wechat-output.ts";
import { prepareReplyFiles } from "../src/bridge/reply-files.ts";
import { parseOutboundPayload } from "../src/media/outbound-media.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { OutboxWorker } from "../src/bridge/outbox-worker.ts";
import { dispatchOutboxItem } from "../src/bridge/outbox-delivery.ts";
import { BridgeEngine } from "../src/bridge/bridge.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";

const session = { baseUrl: "https://example.invalid", botId: "synthetic-bot", controllerUserId: "synthetic-user", botToken: "synthetic-token" };

test("arbitrarily long Unicode replies retain all paragraphs and their final marker", () => {
  const paragraph = "段落👩🏽‍💻：" + "正文内容。".repeat(28) + "\n\n";
  const text = paragraph.repeat(100) + "FULL_REPLY_END";
  const parts = formatWechatFinalReply(text);
  assert(parts.length > 20);
  assert.equal(parts.join(""), text);
  assert(parts.every(p => Buffer.byteLength(p, "utf8") <= 2_000));
  assert(parts.slice(0, -1).every(p => p.endsWith("\n\n")));
  assert(!parts.some(p => p.includes("内容已截断")));
});

test("inline file links, file URIs and relative links are extracted without treating web citations or code as files", () => {
  const text = '查看[报告](<C:\\Work\\report (1).md>)，还有[表格](./data.xlsx)。\n[网站](https://example.com/report.pdf)\n`[代码示例](C:/Work/example.txt)`\n```md\n[另一个示例](C:/Work/ignored.txt)\n```\n[图片](file:///C:/Work/image.png)';
  const result = extractWechatLocalFileReferences(text);
  assert.deepEqual(result.references.map(r => r.label), ["报告", "表格", "图片"]);
  assert.match(result.text, /查看报告，还有表格/u);
  assert.match(result.text, /https:\/\/example.com/u);
  assert.match(result.text, /ignored.txt/u);
  assert.match(result.text, /代码示例/u);
});

test("linked task files become immutable attachments with no two-file cap; unsafe references fail explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "reply-files-"));
  const workspace = join(root, "workspace"), outbound = join(root, "outbound");
  mkdirSync(workspace);
  const names = ["one.md", "two (2).txt", "three.csv"];
  for (const [i, name] of names.entries()) writeFileSync(join(workspace, name), `FILE_${i}`);
  writeFileSync(join(root, "outside.txt"), "not authorized");
  try {
    const text = `结果：\n[第一个](<${join(workspace, names[0]!)}>)\n[第二个](<./two (2).txt>)\n[第三个](${pathToFileURL(join(workspace, names[2]!)).href})\n[重复](<${join(workspace, names[0]!)}>)\n[外部](../outside.txt)\n[不存在](missing.txt)\n正文结尾`;
    const reply = prepareReplyFiles({ text, workspaceRoot: workspace, exportRoot: outbound });
    assert.equal(reply.bodies.length, 3);
    const content = reply.bodies.map(body => {
      const payload = parseOutboundPayload(body);
      assert.equal(payload.type, "local-media");
      if (payload.type !== "local-media") throw new Error("Expected attachment");
      assert.notEqual(payload.path, join(workspace, names[0]!));
      return readFileSync(payload.path, "utf8");
    });
    assert.deepEqual(content, ["FILE_0", "FILE_1", "FILE_2"]);
    assert.match(reply.text, /外部.*文件不在当前任务目录/u);
    assert.match(reply.text, /不存在.*文件不存在/u);
    assert.match(reply.text, /正文结尾/u);
    assert.doesNotMatch(reply.text, /\]\(/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("more than ten persisted parts replay numerically, pause on failure, and survive reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "reply-replay-"));
  let state = new SqliteState(join(root, "state.sqlite"));
  const base = "codex-ilink:synthetic-turn:final";
  const sent: string[] = [];
  let fail = true;
  const sender = { async sendText(input: { clientId: string }) {
    if (input.clientId.endsWith(":part:9") && fail) throw new Error("simulated delivery failure");
    sent.push(input.clientId); return { accepted: true as const, clientId: input.clientId };
  } };
  try {
    const items = Array.from({ length: 17 }, (_, i) => ({ clientId: `${base}:part:${i + 1}`, body: `BODY_${i + 1}`, contextToken: "synthetic-context", targetUserId: session.controllerUserId, createdAtMs: 100 }));
    state.enqueueOutboxBatch(items);
    const worker = new OutboxWorker({ state, session, ilink: sender, now: () => 200, maxAttempts: 1 });
    assert.deepEqual(await worker.drain(), { confirmed: 8, failed: 1, deferred: 8 });
    assert.deepEqual(sent, items.slice(0, 8).map(i => i.clientId));
    state.close(); state = new SqliteState(join(root, "state.sqlite")); fail = false;
    const resumed = new OutboxWorker({ state, session, ilink: sender, now: () => 300 });
    assert.equal((await resumed.drain()).confirmed, 9);
    assert.deepEqual(sent, items.map(i => i.clientId));
    assert.equal(state.listOutboxGroup(base).length, 17);
    assert.equal(state.listPendingOutbox().length, 0);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent completion and replay share one send for a part", async () => {
  const root = mkdtempSync(join(tmpdir(), "reply-flight-"));
  const state = new SqliteState(join(root, "state.sqlite"));
  try {
    const item = state.enqueueOutbox({ clientId: "flight", body: "message", contextToken: "ctx", targetUserId: session.controllerUserId, createdAtMs: 100 });
    let sends = 0;
    const input = { state, item, session, contextToken: "ctx", ilink: { async sendText() { sends++; await new Promise(r => setTimeout(r, 5)); return { accepted: true as const, clientId: item.clientId }; } } };
    await Promise.all([dispatchOutboxItem(input), dispatchOutboxItem(input)]);
    assert.equal(sends, 1);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("pending answer parts retry automatically after cooldown without another inbound message", async () => {
  const root = mkdtempSync(join(tmpdir(), "reply-cooldown-"));
  const state = new SqliteState(join(root, "state.sqlite"));
  let now = 100, offline = true;
  try {
    state.enqueueOutboxBatch([1, 2, 3, 4].map(i => ({ clientId: `codex-ilink:cooldown:final:part:${i}`, body: String(i), contextToken: "ctx", targetUserId: session.controllerUserId, createdAtMs: 1 })));
    const sent: string[] = [];
    const worker = new OutboxWorker({ state, session, maxAttempts: 1, now: () => now, ilink: { async sendText(input) {
      if (offline) throw new Error("offline");
      sent.push(input.text); return { accepted: true as const, clientId: input.clientId };
    } } });
    assert.equal((await worker.drain()).failed, 1);
    offline = false;
    assert.equal((await worker.drain()).confirmed, 0);
    now += 30_000;
    assert.equal((await worker.drain()).confirmed, 4);
    assert.deepEqual(sent, ["1", "2", "3", "4"]);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Bridge persists the full reply and recovery never replays its first eight confirmed parts", async () => {
  const root = mkdtempSync(join(tmpdir(), "reply-bridge-"));
  const state = new SqliteState(join(root, "state.sqlite"));
  const leases = new SqliteTurnLeaseStore(join(root, "state.sqlite"));
  const text = "长回复正文。".repeat(1_500) + "FINAL_END_MARKER";
  const parts = formatWechatFinalReply(text);
  const delivered: string[] = [];
  let fail = true, reads = 0;
  state.createDispatchIntent({ body: "synthetic prompt", contextToken: "ctx", dedupeKey: "key", operationId: "operation", threadId: "thread-synthetic", createdAtMs: 1 });
  state.markDispatchAccepted("operation", "turn-synthetic", 2);
  leases.tryAcquire({ threadId: "thread-synthetic", turnId: "turn-synthetic", owner: "bridge", instanceId: "host", operationId: "operation", createdAtMs: 1 });
  const ilink = { async sendText(input: { text: string; clientId: string }) {
    if (input.clientId.endsWith(":part:9") && fail) throw new Error("synthetic offline");
    delivered.push(input.text); return { accepted: true as const, clientId: input.clientId };
  } };
  const bridge = new BridgeEngine({ state, leases, session, ilink, bridgeInstanceId: "host", now: () => 100, newId: () => "unused", codex: {
    async startTurn() { throw new Error("No model invocation during recovery"); },
    async readThread() { reads++; return { thread: { turns: [{ id: "turn-synthetic", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text }] }] } }; },
  } });
  const event = { method: "turn/completed", params: { threadId: "thread-synthetic", turn: { id: "turn-synthetic", status: "completed" } } };
  try {
    const first = bridge.ingestCodexEvent(event);
    const duplicate = bridge.ingestCodexEvent(event);
    assert.equal(first, duplicate, "Concurrent terminal signals share one delivery plan");
    await assert.rejects(first, /synthetic offline/u);
    assert.equal(delivered.length, 8);
    assert.equal(state.listOutboxGroup("codex-ilink:turn-synthetic:final").length, parts.length);
    fail = false;
    const worker = new OutboxWorker({ state, session, ilink, now: () => 200 });
    await worker.drain();
    assert.equal(createHash("sha256").update(delivered.join("")).digest("hex"), createHash("sha256").update(text).digest("hex"));
    await bridge.ingestCodexEvent(event);
    assert.equal(reads, 1);
    assert.equal(delivered.length, parts.length);
  } finally { bridge.close(); leases.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
});

test("internal skill citations remain labels and never become implicit attachments",()=>{
 const text='规则见 [Computer Use 技能](C:/Users/example/.codex/plugins/cache/computer-use/skills/computer-use/SKILL.md:12)。';
 const r=extractWechatLocalFileReferences(text);assert.equal(r.references.length,0);assert.equal(r.text,'规则见 Computer Use 技能。');
});

test("internal instruction references do not emit attachment failure warnings or paths",()=>{
 for(const path of ['C:/Users/example/.codex/skills/a/SKILL.md#L12','file:///C:/Users/example/.codex/plugins/a/docs/guidance.md','C:/project/AGENTS.md','C:/project/SKILL%2Emd']){
  const r=prepareReplyFiles({text:`[技能引用](${path})`,workspaceRoot:'C:/workspace',exportRoot:'C:/exports'});assert.equal(r.text,'技能引用');assert.deepEqual(r.bodies,[]);
 }
 const ordinary=extractWechatLocalFileReferences('[项目说明](C:/project/README.md)');assert.equal(ordinary.references.length,1);
});
