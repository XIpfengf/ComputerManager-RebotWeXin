import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { SqliteState } from "../src/bridge/sqlite-state.ts";
import { SqliteTurnLeaseStore } from "../src/coordination/turn-lease.ts";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import { HistoryService } from "../src/history/history-service.ts";
import { parseInboundText, routedControlIntent } from "../src/bridge/commands.ts";
const DAY=86400000;
function fixture(t:{after(fn:()=>void):void}){
  const root=mkdtempSync(join(tmpdir(),"ilink-history-"));const state=new SqliteState(join(root,"state.sqlite"));const accounts=new AccountStore(root);accounts.register("primary","a","bot-a");accounts.register("second","b","bot-b");const leases=new SqliteTurnLeaseStore(join(root,"state.sqlite"));let now=200*DAY;
  state.setMainThreadId("thread-0");state.setBinding({threadId:"thread-1",projectPath:null,updatedAtMs:1,expiresAtMs:Number.MAX_SAFE_INTEGER});
  const rows=new Map<string,{id:string;name:string;at:number;archived:boolean;pinned:boolean;busy:boolean}>();
  for(let i=0;i<28;i++){const id=`thread-${i}`;accounts.claimThread("primary",id);rows.set(id,{id,name:id,at:now-(i+1)*DAY*2,archived:false,pinned:false,busy:false});}
  accounts.claimThread("second","other-thread");rows.set("other-thread",{id:"other-thread",name:"SECRET",at:DAY,archived:false,pinned:false,busy:false});
  rows.set("unmanaged",{id:"unmanaged",name:"Desktop",at:DAY,archived:false,pinned:false,busy:false});
  const archived:string[]=[],restored:string[]=[];let failArchive=false;let beforeRead:((id:string)=>void)|undefined;
  const codex={async listThreads({archived}:{archived:boolean}){return {data:[...rows.values()].filter(r=>r.archived===archived).map(r=>({id:r.id,name:r.name,updatedAt:now/1000})),nextCursor:null};},
    async readThread({threadId}:{threadId:string}){beforeRead?.(threadId);const r=rows.get(threadId)!;return {thread:{id:r.id,isPinned:r.pinned,status:{type:r.busy?"active":"idle"},turns:[{status:"completed",startedAt:r.at/1000,completedAt:r.at/1000,items:[{type:"userMessage"},{type:"agentMessage"}]}]}};},
    async archiveThread(id:string){archived.push(id);if(failArchive)throw Error("unknown outcome");rows.get(id)!.archived=true;return {thread:{id}};},
    async unarchiveThread(id:string){restored.push(id);rows.get(id)!.archived=false;return {thread:{id}};},
  } as unknown as CodexRuntime;
  const opts={accounts,account:"primary",codex,state,leases,instanceId:"host",now:()=>now};const service=new HistoryService(opts);
  t.after(()=>{leases.close();state.close();accounts.close();rmSync(root,{recursive:true,force:true});});
  return {root,state,accounts,leases,rows,archived,restored,service,opts,advance(ms:number){now+=ms;},fail(){failArchive=true;},onRead(fn:(id:string)=>void){beforeRead=fn;}};
}
test("defaults disabled; preview respects actual message age, recent20, current/main, pinned and ownership",async t=>{
  const f=fixture(t);f.rows.get("thread-22")!.pinned=true;await f.service.command("history pin thread-23");f.rows.get("thread-24")!.busy=true;
  const lease=f.leases.tryAcquire({threadId:"thread-25",owner:"desktop",instanceId:"desktop",operationId:"op",turnId:"turn",createdAtMs:1});assert.ok(lease.acquired);
  const preview=await f.service.preview();assert.deepEqual(preview.candidates.map(c=>c.id),["thread-20","thread-21","thread-26","thread-27"]);
  assert.ok(preview.excluded.some(e=>e.id==="thread-0"&&e.reason==="主会话"));assert.doesNotMatch(JSON.stringify(preview),/other-thread|unmanaged|SECRET/);
  await f.service.tick();assert.equal(f.archived.length,0);assert.match(await f.service.command("history policy"),/关闭/);
});
test("archive requires account-local one-time confirmation and preserves original files/binding",async t=>{
  const f=fixture(t);const file=join(f.root,"user-file.txt");writeFileSync(file,"KEEP");
  const prompt=await f.service.command("history archive");const code=/confirm ([A-F0-9]+)/u.exec(prompt)![1]!;assert.equal(f.archived.length,0);
  const other=new HistoryService({...f.opts,account:"second"});assert.match(await other.command(`history archive confirm ${code}`),/无效/);
  assert.match(await f.service.command(`history archive confirm ${code}`),/成功 8/);assert.equal(f.state.getBinding(200*DAY)!.threadId,"thread-1");assert.equal(readFileSync(file,"utf8"),"KEEP");
  assert.match(await f.service.command(`history archive confirm ${code}`),/无效/);
});
test("state changes between preview and apply exclude newly current/pinned/busy threads",async t=>{
  const f=fixture(t);const prompt=await f.service.command("history archive");const code=/confirm ([A-F0-9]+)/u.exec(prompt)![1]!;
  f.state.setBinding({threadId:"thread-20",projectPath:null,updatedAtMs:1,expiresAtMs:Number.MAX_SAFE_INTEGER});f.rows.get("thread-21")!.pinned=true;f.rows.get("thread-22")!.at=200*DAY;
  await f.service.command(`history archive confirm ${code}`);assert.ok(!f.archived.includes("thread-20"));assert.ok(!f.archived.includes("thread-21"));assert.ok(!f.archived.includes("thread-22"));
});
test("automatic scan is per-day and durable across restart; disable stops further scans",async t=>{
  const f=fixture(t);await f.service.command("history enable");await f.service.tick();assert.equal(f.archived.length,8);const count=f.accounts.database.prepare("SELECT COUNT(*) n FROM history_operations").get()!.n;
  await new HistoryService(f.opts).tick();assert.equal(f.accounts.database.prepare("SELECT COUNT(*) n FROM history_operations").get()!.n,count);
  f.advance(DAY);await f.service.command("history disable");await f.service.tick();assert.equal(f.archived.length,8);
});
test("unknown archive results are reconciled before new attempts; successful late results are not repeated",async t=>{
  const f=fixture(t);f.fail();const prompt=await f.service.command("history archive");const code=/confirm ([A-F0-9]+)/u.exec(prompt)![1]!;assert.match(await f.service.command(`history archive confirm ${code}`),/待对账 8/);
  assert.equal((await f.service.preview()).candidates.length,0);f.rows.get("thread-20")!.archived=true;await f.service.command("history reconcile");
  assert.equal(f.accounts.database.prepare("SELECT status FROM history_operations WHERE thread_id='thread-20'").get()!.status,"confirmed");
  f.advance(61000);await f.service.command("history reconcile");assert.ok((await f.service.preview()).candidates.some(c=>c.id==="thread-21"));assert.equal(f.archived.length,8);
});
test("restore preserves current selection and rejects another channel or unregistered Desktop thread",async t=>{
  const f=fixture(t);f.rows.get("thread-27")!.archived=true;assert.match(await f.service.command("history restore thread-27"),/已恢复/);assert.deepEqual(f.restored,["thread-27"]);
  assert.equal(f.state.getBinding(200*DAY)!.threadId,"thread-1");assert.match(await f.service.command("history restore other-thread"),/只能操作/);assert.match(await f.service.command("history pin unmanaged"),/只能操作/);
});
test("pending deliveries and approvals block archive; uncertain Desktop pin lookup fails closed",async t=>{
  const f=fixture(t);const approving=new HistoryService({...f.opts,approvalBusy:id=>id==="thread-20"});assert.ok(!(await approving.preview()).candidates.some(c=>c.id==="thread-20"));
  const uncertain=new HistoryService({...f.opts,desktopPinned:()=>{throw Error("unknown pin state");}});await assert.rejects(uncertain.preview(),/pin state/);
  f.state.enqueueOutbox({body:"pending",clientId:"pending",contextToken:"ctx",targetUserId:"a",createdAtMs:1});assert.equal((await f.service.preview()).candidates.length,0);
});
test("policy change, elapsed time and process restart invalidate confirmation; NLP cannot write history policy",async t=>{
  const f=fixture(t);let prompt=await f.service.command("history archive");let code=/confirm ([A-F0-9]+)/u.exec(prompt)![1]!;await f.service.command("history enable");assert.match(await f.service.command(`history archive confirm ${code}`),/无效/);
  prompt=await f.service.command("history archive");code=/confirm ([A-F0-9]+)/u.exec(prompt)![1]!;f.advance(120001);assert.match(await f.service.command(`history archive confirm ${code}`),/无效/);
  assert.match(await new HistoryService(f.opts).command(`history archive confirm ${code}`),/无效/);
  assert.equal(parseInboundText("history policy").kind,"historyControl");assert.equal(routedControlIntent({kind:"historyControl",command:"history enable"}),null);
});
test("failed daily scan is recorded and notified without deleting or immediately retrying",async t=>{
  const f=fixture(t);const notices:string[]=[];const service=new HistoryService({...f.opts,desktopPinned:()=>{throw Error("pin lookup unavailable");},notify:async text=>{notices.push(text);}});
  await service.command("history enable");await service.tick();assert.equal(f.archived.length,0);assert.match(notices[0]!,/扫描未完成/);
  assert.match(await service.command("history policy"),/pin lookup unavailable/);await service.tick();assert.equal(notices.length,1);
});
test("native notLoaded historical threads are eligible only with terminal message turns and no lease",async t=>{
  const f=fixture(t);const original=f.opts.codex.readThread.bind(f.opts.codex);
  f.opts.codex.readThread=async input=>{const result=await original(input);result.thread.status={type:"notLoaded"};return result;};
  assert.equal((await f.service.preview()).candidates.length,8);
  const lease=f.leases.tryAcquire({threadId:"thread-20",owner:"desktop",instanceId:"desktop",operationId:"active",turnId:"active-turn",createdAtMs:1});assert.ok(lease.acquired);
  assert.ok(!(await f.service.preview()).candidates.some(c=>c.id==="thread-20"));
});
