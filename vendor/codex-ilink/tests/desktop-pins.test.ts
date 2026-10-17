import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import {isDesktopThreadPinned} from "../src/windows/desktop-pins.ts";
test("Desktop pin lookup is read-only and refuses missing/changed schemas",t=>{
  const root=mkdtempSync(join(tmpdir(),"ilink-desktop-pins-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const env={CODEX_HOME:root};
  assert.throws(()=>isDesktopThreadPinned("a",env));const db=new DatabaseSync(join(root,"state_5.sqlite"));db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,is_pinned INTEGER);INSERT INTO threads VALUES('a',1),('b',0)");db.close();
  assert.equal(isDesktopThreadPinned("a",env),true);assert.equal(isDesktopThreadPinned("b",env),false);assert.throws(()=>isDesktopThreadPinned("missing",env));
  const newer=new DatabaseSync(join(root,"state_10.sqlite"));newer.exec("CREATE TABLE threads(id TEXT)");newer.close();assert.throws(()=>isDesktopThreadPinned("a",env),/格式变化/);
});
