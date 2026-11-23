import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import { defaultProfile, validateProfile, setProfileField, compilePersona } from "../src/profiles/profile.ts";
import { hash, ProfileStore } from "../src/profiles/profile-store.ts";
import { ChannelProfileService } from "../src/profiles/channel-profile.ts";
import { parseInboundText, routedControlIntent } from "../src/bridge/commands.ts";

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "ilink-profile-")); const db = new DatabaseSync(join(root, "state.sqlite")); const store = new ProfileStore(db, root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); }); return { root, db, store };
}
function fakeRuntime() {
  let calls = 0;
  const r = {
    async readDefaultModelSettings() { return { model: "model-a", effort: "low" }; },
    async listModels() { calls++; return { data: [{ id: "model-a", model: "model-a", displayName: "A", hidden: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }, { reasoningEffort: "high", description: "high" }] }, { id: "model-b", model: "model-b", displayName: "B", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }] }], nextCursor: null }; },
    async archiveThread() {},
  };
  return { runtime: r as unknown as CodexRuntime, calls: () => calls };
}
test("strict schema rejects unknown fields, bad types, ranges, unicode length and arbitrary workspace", () => {
  for (const update of [ { extra: 1 }, { revision: 0 }, { schemaVersion: 2 }, { persona: { ...defaultProfile().persona, intensity: 6 } }, { persona: { ...defaultProfile().persona, name: "🦊".repeat(41) } }, { expression: { ...defaultProfile().expression, warmthLevel: "2" } }, { session: { ...defaultProfile().session, workspace: { mode: "project", projectKey: "C:\\private" } } } ]) assert.throws(() => validateProfile({ ...defaultProfile(), ...update }));
  assert.equal(setProfileField(defaultProfile(), "name", "🦊".repeat(40)).persona.name.length, 80);
  assert.equal(setProfileField(defaultProfile(), "address", '""').persona.userAddress, "");
  assert.throws(() => setProfileField(defaultProfile(), "revision", "20"));
  assert.throws(() => setProfileField(defaultProfile(), "role", "字".repeat(4001)));
  assert.throws(() => validateProfile({ ...defaultProfile(), padding: "x".repeat(70000) }));
});
test("channel files/revisions and immutable snapshots isolate accounts; last valid backup survives manual edits", async t => {
  const { store } = setup(t); store.initialize("primary"); store.initialize("second");
  const original = store.load("primary"); const next = store.save("primary", setProfileField(original, "name", "小白狐"));
  assert.equal(next.revision, 2); assert.equal(store.load("second").persona.name, "电脑管家");
  assert.equal(JSON.parse(readFileSync(`${store.file("primary")}.bak`, "utf8")).revision, 1);
  store.snapshot({ account: "primary", threadId: "thread-1", profile: next, instructions: compilePersona(next), model: "model-a", effort: "low", cwd: "workspace" });
  store.save("primary", setProfileField(next, "name", "新身份"));
  assert.equal(store.thread("thread-1", "primary")!.profile.persona.name, "小白狐");
  assert.throws(() => store.thread("thread-1", "second")); assert.throws(() => store.file("../bad"));
  const edit = store.load("primary"); edit.expression.toneDescription = "亲和"; writeFileSync(store.file("primary"), JSON.stringify(edit));
  assert.throws(() => store.load("primary"), /外部修改/); assert.throws(() => store.save("primary", next), /外部修改/);
  const reloaded = await store.reload("primary", async () => {}); assert.equal(reloaded.revision, 4); assert.equal(reloaded.expression.toneDescription, "亲和");
  assert.equal(JSON.parse(readFileSync(`${store.file("primary")}.bak`, "utf8")).persona.name, "新身份");
});
test("crash recovery handles old/new file hashes and refuses a third-party edit", t => {
  const { store, db } = setup(t); store.initialize("primary");
  const before = store.current("primary")!; const next = setProfileField(store.load("primary"), "name", "恢复身份"); next.revision = 2; const payload = `${JSON.stringify(next, null, 2)}\n`;
  db.prepare("INSERT INTO profile_change_intents VALUES(?,?,?,?,?,?)").run("pending", "primary", before.hash, payload, hash(payload), before.payload);
  writeFileSync(store.file("primary"), "third-party"); assert.throws(() => store.recover("primary"), /第三方/); assert.equal(readFileSync(store.file("primary"), "utf8"), "third-party");
  writeFileSync(store.file("primary"), before.payload); assert.equal(store.load("primary").revision, 2);
  const third = { ...next, revision: 3 }; const thirdPayload = JSON.stringify(third);
  db.prepare("INSERT INTO profile_change_intents VALUES(?,?,?,?,?,?)").run("pending2", "primary", hash(payload), thirdPayload, hash(thirdPayload), payload);
  writeFileSync(store.file("primary"), thirdPayload); assert.equal(store.load("primary").revision, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM profile_change_intents").get()!.n, 0);
});
test("fixed config syntax cannot be created by the natural-language router", () => {
  assert.deepEqual(parseInboundText("config set tone 友好\n但直接"), { kind: "profileConfig", command: "config set tone 友好\n但直接" });
  assert.equal(parseInboundText("请把 config set name 小白狐 作为示例").kind, "message");
  assert.equal(routedControlIntent({ kind: "profileConfig", command: "config reset" }), null);
});
test("commands validate model/effort atomically, preserve defaults and bind reset to revision/channel", async t => {
  const { store } = setup(t); const fake = fakeRuntime(); const service = new ChannelProfileService({ store, account: "primary", runtime: fake.runtime, projects: () => [] });
  await service.command("config set name 小白狐"); assert.equal(fake.calls(), 0);
  await service.command("config set effort high"); const rev = store.load("primary").revision;
  assert.match(await service.command("config set model model-b"), /失败/); assert.equal(store.load("primary").revision, rev);
  await service.command("config set effort inherit"); assert.match(await service.command("config set model model-b"), /已保存/);
  assert.match(await service.command("config models"), /model-a/); assert.match(await service.command("config efforts"), /medium/);
  const prompt = await service.command("config reset"); const code = /confirm ([A-F0-9]+)/u.exec(prompt)![1]!;
  await service.command("config set warmth 4"); assert.match(await service.command(`config reset confirm ${code}`), /失败/);
  const prompt2 = await service.command("config reset"); const code2 = /confirm ([A-F0-9]+)/u.exec(prompt2)![1]!;
  assert.match(await service.command(`config reset confirm ${code2}`), /已保存/); assert.equal(store.load("primary").persona.name, "电脑管家");
  assert.match(await service.command(`config reset confirm ${code2}`), /失败/);
});
test("serialized saves do not lose updates; new session snapshot is fixed and validates returned native settings", async t => {
  const { store } = setup(t); const fake = fakeRuntime(); const service = new ChannelProfileService({ store, account: "primary", runtime: fake.runtime, projects: () => [] });
  await Promise.all([service.command("config set name 小白狐"), service.command("config set warmth 5")]); const p = store.load("primary"); assert.equal(p.revision, 3); assert.equal(p.persona.name, "小白狐"); assert.equal(p.expression.warmthLevel, 5);
  const create: CodexRuntime["startThread"] = async (cwd, _permissions, identity) => ({ thread: { id: "native-1" }, model: identity!.model, reasoningEffort: identity!.effort, cwd });
  await service.start("cwd", {}, create); await service.command("config set name 别名");
  assert.equal(store.thread("native-1")!.profile.persona.name, "小白狐"); assert.equal(store.thread("native-1")!.model, "model-a");
  await assert.rejects(service.start("cwd", {}, async () => ({ thread: { id: "wrong" }, model: "wrong" })), /不一致/); assert.equal(store.thread("wrong"), null);
});
test("stable project keys survive list reorder and explicit project overrides profile default", async t => {
  const { store, root } = setup(t); const fake = fakeRuntime(); const a = join(root,"a"), b = join(root,"b"); mkdirSync(a); mkdirSync(b); let projects = [{ name: "A", cwd: a }, { name: "B", cwd: b }];
  const service = new ChannelProfileService({ store, account: "primary", runtime: fake.runtime, projects: () => projects });
  await service.command("config"); const key = (await service.projectCatalog())[0]!.key; await service.command(`config set workspace project:${key}`); projects.reverse();
  assert.equal(await service.workspace(null), a); assert.equal(await service.workspace(b), b); projects = [];
  await assert.rejects(service.workspace(null), /不可用/);
});

test("compiled persona guides scene changes while keeping identity data, current-turn control and factual limits", () => {
  const profile = defaultProfile(); profile.persona.name = "合成角色"; profile.persona.intensity = 5;
  profile.expression.tsundereLevel = 4; profile.expression.humorLevel = 3; profile.conversation.taskPersonaLevel = 1;
  const before = structuredClone(profile), instructions = compilePersona(profile);
  assert.deepEqual(profile, before);
  assert.match(instructions, /直接给结果.*本轮/s);
  assert.match(instructions, /受挫.*先回应/s);
  assert.match(instructions, /善意.*调侃/s);
  assert.match(instructions, /分歧.*依据/s);
  assert.match(instructions, /冲突.*不能.*确定事实/s);
  assert.match(instructions, /数字.*否定.*路径.*代码.*附件.*完成状态/s);
  assert.match(instructions, /实际操作、风险、失败与审批时采用 1\/5/);
  assert.ok(Buffer.byteLength(instructions) < 16000);
});

test("v1 identity instructions remain frozen while future sessions use the v2 expression compiler", async t => {
  const { store, db } = setup(t), fake = fakeRuntime(); store.initialize("primary");
  const oldProfile = defaultProfile(); oldProfile.persona.name = "原角色";
  const oldInstructions = "合成旧身份指令，不得自动追写";
  const old = { account: "primary", threadId: "old-v1", profile: oldProfile, instructions: oldInstructions, compilerVersion: 1, instructionHash: hash(oldInstructions), model: "model-a", effort: "low", cwd: "workspace" };
  db.prepare("INSERT INTO thread_profiles VALUES(?,?,?)").run("old-v1", "primary", JSON.stringify(old));
  const service = new ChannelProfileService({ store, account: "primary", runtime: fake.runtime, projects: () => [] });
  await service.command("config set name 新角色");
  await service.start("workspace", {}, async (cwd, _permissions, identity) => ({ thread: { id: "new-v2" }, cwd, model: identity!.model, reasoningEffort: identity!.effort }));
  assert.deepEqual(store.thread("old-v1"), old);
  assert.equal(store.thread("new-v2")!.compilerVersion, 2); assert.equal(store.thread("new-v2")!.profile.persona.name, "新角色");
  assert.equal(store.thread("legacy"), null);
  const neutral = defaultProfile(); neutral.persona.intensity = 0; neutral.expression.warmthLevel = 0; neutral.expression.humorLevel = 0;
  const instructions = compilePersona(neutral);
  assert.doesNotMatch(instructions, /听起来今天很耗力|总算收尾了/);
});

test("accounts outside pilot scope can create new sessions with the baseline compiler", async t => {
  const { store } = setup(t), fake = fakeRuntime();
  const service = new ChannelProfileService({ store, account: "primary", runtime: fake.runtime, projects: () => [], compilerVersion: 1 });
  await service.start("workspace", {}, async (cwd, _permissions, identity) => ({ thread: { id: "baseline-new" }, cwd, model: identity!.model, reasoningEffort: identity!.effort }));
  const snapshot = store.thread("baseline-new")!;
  assert.equal(snapshot.compilerVersion, 1); assert.doesNotMatch(snapshot.instructions, /直接给结果|受挫示例/);
  assert.match(snapshot.instructions, /新会话不自动带入旧消息/);
});
