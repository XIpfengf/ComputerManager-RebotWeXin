import test from "node:test";
import assert from "node:assert/strict";
import { resolveDelegationTargets } from "../src/delegation/catalog.ts";

test("a project selector returns its newest bounded titles without treating the project name as a title", async () => {
  const calls: unknown[] = [];
  const result = await resolveDelegationTargets("Fixture", [{ name: "Fixture", cwd: "D:\\Fixture" }], async (search, cursor, cwd) => {
    calls.push({ search, cursor, cwd });
    return { data: [{ id: "newest", name: "最新任务", cwd: "D:\\Fixture", updatedAt: 20 }, { id: "older", name: "之前任务", updatedAt: 10 }], nextCursor: "older-page" };
  });
  assert.deepEqual(calls, [{ search: "", cursor: undefined, cwd: "D:\\Fixture" }]);
  assert.deepEqual(result.map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })), [{ id: "newest", title: "最新任务", updatedAt: 20 }, { id: "older", title: "之前任务", updatedAt: 10 }]);
});


test("title lookup keeps paging and exact-title precedence", async () => {
  const calls: (string | undefined)[] = [];
  const result = await resolveDelegationTargets("目标", [], async (_search, cursor) => {
    calls.push(cursor);
    return cursor ? { data: [{ id: "exact", name: "目标" }], nextCursor: null } : { data: [{ id: "quoted", name: "告诉目标做事" }], nextCursor: "next" };
  });
  assert.deepEqual(calls, [undefined, "next"]);
  assert.deepEqual(result.map(t => t.id), ["exact"]);
});

test("topic search retains Desktop matches whose current title differs from the topic", async () => {
  const read = async () => ({
    data: [{ id: "topic-thread", name: "整理平台任务需求", preview: "请检查课题实现方案" }],
    nextCursor: null,
  });
  const result = await resolveDelegationTargets("课题实现", [], read, true);
  assert.deepEqual(result, [{ id: "topic-thread", title: "整理平台任务需求" }]);
  assert.deepEqual(await resolveDelegationTargets("课题实现", [], read), []);
});

test("ambiguous project names and repeated cursors never silently select a target", async () => {
  let calls = 0;
  await assert.rejects(resolveDelegationTargets("Fixture", [{ name: "Fixture", cwd: "D:\\One" }, { name: "Fixture", cwd: "D:\\Two" }], async () => { calls++; return { data: [], nextCursor: null }; }), /项目名称不唯一/);
  assert.equal(calls, 0);
  await assert.rejects(resolveDelegationTargets("任务", [], async () => ({ data: [], nextCursor: "same" })), /分页重复/);
});
