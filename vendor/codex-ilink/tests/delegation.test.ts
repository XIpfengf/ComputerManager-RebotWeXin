import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DelegationStore,DelegationService,type DelegationJob} from "../src/delegation/delegation-service.ts";
import {discoverDesktopTools,type DesktopTools} from "../src/delegation/desktop-tools.ts";
import {selectDelegationTargets,resolveDelegationTargets} from "../src/delegation/catalog.ts";

test("exact Desktop title outranks previews quoting the target; true duplicate titles stay ambiguous",()=>{const target={id:"target",title:"Desktop验收"};assert.deepEqual(selectDelegationTargets([target,{id:"origin",title:"告诉会话 Desktop验收 执行测试"},target],"Desktop验收"),[target]);assert.equal(selectDelegationTargets([target,{id:"other",title:target.title}],target.title).length,2);assert.equal(selectDelegationTargets([target,{id:"other",title:"其他验收"}],"验收").length,2);});

function fixture(){
 const db=new DatabaseSync(":memory:");const store=new DelegationStore(db);const root=mkdtempSync(join(tmpdir(),"ilink-delegation-"));let now=10000;let busy=false;let failSend=false;let closed=0;let reads=0;const sent:Array<Record<string,any>>=[];const notices:string[]=[];let result:Record<string,any>[]=[];
 const tools:DesktopTools={call:async(_c,tool,args)=>{if(tool==="send_message_to_thread"){sent.push(args);if(failSend)throw Error("unknown");return {threadId:"target"};}reads++;return {thread:{status:{type:busy?"active":"idle"}},turns:result};},close:()=>{closed++;}};
 const options={account:"primary",store,root,owner:(id:string)=>id==="foreign"?"secondary":"primary",explicitOwner:(id:string)=>id==="foreign"?"secondary":undefined,resolve:async(_s:string)=>[{id:"target",title:"验收会话"}],tools:()=>tools,notify:async(_j:DelegationJob,text:string)=>{notices.push(text);return true;},now:()=>now};
 const service=new DelegationService(options);const context={threadId:"origin",turnId:"origin-turn"};const source={text:"告诉验收会话执行测试，完成返回",contextToken:"test-context"};
 return {db,store,options,service,context,source,sent,notices,submit:()=>service.command(context,{action:"submit",target:"验收会话",instruction:"仅测试"},source),advance:()=>{now+=6000;},busy:(v:boolean)=>{busy=v;},failSend:()=>{failSend=true;},complete:(j:DelegationJob,text=`[iLink委派:${j.id}] RESULT_OK`)=>{result=[{id:"target-turn",status:"completed",items:[{type:"agentMessage",phase:"final_answer",text}]}];},reads:()=>reads,closed:()=>closed};
}
test("submission is durable and idempotent; tool registration alone never sends",async()=>{const f=fixture();try{const a=JSON.parse(await f.submit());const b=JSON.parse(await f.submit());assert.equal(a.id,b.id);assert.equal(f.store.all().length,1);assert.equal(f.sent.length,0);}finally{f.db.close();}});
test("requires current user authorization for the specified target",async()=>{const f=fixture();try{await assert.rejects(f.service.command(f.context,{action:"submit",target:"验收会话",instruction:"测试"},{...f.source,text:"查一下进度"}),/授权/);assert.equal(f.store.all().length,0);}finally{f.db.close();}});
test("busy Desktop target is queued without sending; later sends once",async()=>{const f=fixture();try{await f.submit();f.busy(true);await f.service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.all()[0]?.status,"queued");f.advance();f.busy(false);await f.service.tick();f.advance();await f.service.tick();assert.equal(f.sent.length,1);assert.equal(f.store.all()[0]?.status,"running");}finally{f.db.close();}});
test("lost send response is persisted unknown and never automatically resent, including recovery",async()=>{const f=fixture();try{await f.submit();f.failSend();await f.service.tick();assert.equal(f.store.all()[0]?.status,"unknown");f.store.recover();f.advance();await new DelegationService(f.options).tick();assert.equal(f.sent.length,1);}finally{f.db.close();}});
test("crash between sending checkpoint and acknowledgement cannot replay a task",async()=>{const f=fixture();try{await f.submit();const j=f.store.all()[0]!;j.status="sending";f.store.save(j);new DelegationStore(f.db).recover();await f.service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.all()[0]?.status,"unknown");}finally{f.db.close();}});
test("completion requires exact job marker, then is delivered back to its account",async()=>{const f=fixture();try{await f.submit();await f.service.tick();const j=f.store.all()[0]!;f.complete(j,"Unrelated completed task");f.advance();await f.service.tick();assert.equal(f.store.all()[0]?.status,"running");f.complete(j);f.advance();await f.service.tick();assert.equal(f.store.all()[0]?.targetTurn,"target-turn");f.advance();await f.service.tick();assert.equal(f.store.all()[0]?.status,"delivered");assert.match(f.notices.at(-1)!,/RESULT_OK/);assert.equal(f.sent.length,1);}finally{f.db.close();}});
test("delivery failure is retried without executing target again",async()=>{const f=fixture();try{let available=false;const service=new DelegationService({...f.options,notify:async()=>available});await f.submit();await service.tick();f.complete(f.store.all()[0]!);f.advance();await service.tick();f.advance();await service.tick();assert.equal(f.store.all()[0]?.status,"completed");available=true;f.advance();await service.tick();assert.equal(f.store.all()[0]?.status,"delivered");assert.equal(f.sent.length,1);}finally{f.db.close();}});
test("secondary cannot access primary defaults or other channels; grants cannot steal explicit ownership",async()=>{const f=fixture();try{const s=new DelegationService({...f.options,account:"secondary"});assert.equal(s.allowed("target"),false);writeFileSync(join(f.options.root,"delegation-permissions.json"),JSON.stringify({version:1,accounts:{secondary:{allowDesktopThreads:["target","stolen"]}}}));assert.equal(s.allowed("target"),true);const strict=new DelegationService({...f.options,account:"secondary",explicitOwner:()=>"primary"});assert.equal(strict.allowed("target"),false);assert.equal(JSON.parse(await s.command(f.context,{action:"list"},f.source)).length,0);}finally{f.db.close();}});
test("ambiguous names reject without creating jobs",async()=>{const f=fixture();try{const s=new DelegationService({...f.options,resolve:async()=>[{id:"a",title:"test"},{id:"b",title:"test"}]});const r=JSON.parse(await s.command(f.context,{action:"submit",target:"验收会话",instruction:"测试"},f.source));assert.equal(r.status,"needs_confirmation");assert.equal(r.candidates.length,2);assert.equal(f.store.all().length,0);}finally{f.db.close();}});
test("cancelling queued work never stops a target; running cancellation is refused",async()=>{const f=fixture();try{await f.submit();const j=f.store.all()[0]!;await f.service.command(f.context,{action:"cancel",jobId:j.id},{...f.source,text:`取消委派 ${j.id}`});await f.service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.all()[0]?.status,"cancelled");}finally{f.db.close();}});
test("connection discovery works without inherited endpoint, rejects ambiguity, and rotates stale endpoint",()=>{const root=mkdtempSync(join(tmpdir(),"ilink-tools-"));mkdirSync(join(root,"plugins/cache/openai-bundled/codex-app-tools/0.1.6"),{recursive:true});const a="codex-app-tools-11111111-1111-1111-1111-111111111111",b="codex-app-tools-22222222-2222-2222-2222-222222222222";assert.match(discoverDesktopTools({CODEX_HOME:root},()=>[a]).endpoint,/111111/);assert.throws(()=>discoverDesktopTools({CODEX_HOME:root},()=>[a,b]),/AMBIGUOUS/);assert.match(discoverDesktopTools({CODEX_HOME:root,CODEX_APP_TOOLS_PIPE_PATH:`\\\\.\\pipe\\${a}`},()=>[b]).endpoint,/222222/);assert.throws(()=>discoverDesktopTools({CODEX_HOME:root},()=>[]),/UNAVAILABLE/);});

test("cancel racing with the idle probe cannot send a cancelled task",async()=>{const f=fixture();try{await f.submit();const job=f.store.all()[0]!;let changed=false;const tools=f.options.tools();const service=new DelegationService({...f.options,tools:()=>({...tools,call:async(c,t,a)=>{const r=await tools.call(c,t,a);if(!changed&&t==="read_thread"){changed=true;await f.service.command(f.context,{action:"cancel",jobId:job.id},{...f.source,text:`取消 ${job.id}`});}return r;}})});await service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.all()[0]?.status,"cancelled");}finally{f.db.close();}});
test("revocation prevents any further target reads or sends",async()=>{const f=fixture();try{await f.submit();const s=new DelegationService({...f.options,owner:()=>"secondary",explicitOwner:()=>"secondary"});await s.tick();assert.equal(f.reads(),0);assert.equal(f.sent.length,0);assert.match(f.store.all()[0]!.issue!,/撤销/);}finally{f.db.close();}});
test("long final results are hydrated without using the clipped Desktop preview",async()=>{const f=fixture();try{await f.submit();await f.service.tick();const job=f.store.all()[0]!;f.complete(job);const full=`[iLink委派:${job.id}]\n`+"完整段落。".repeat(10000)+"完整结尾";f.advance();const s=new DelegationService({...f.options,readResult:async()=>full});await s.tick();assert.equal(f.store.all()[0]?.result,full);f.advance();await s.tick();assert(f.notices.at(-1)!.endsWith("完整结尾"));}finally{f.db.close();}});
test("expired source request is rejected before persisting work",async()=>{const f=fixture();try{await assert.rejects(f.service.command(f.context,{action:"submit",target:"验收会话",instruction:"test"},{...f.source,isLive:()=>false}),/失效/);assert.equal(f.store.all().length,0);}finally{f.db.close();}});

test("unloaded completed Desktop target receives its queued job exactly once",async()=>{
 const f=fixture();try{await f.submit();const original=f.options.tools();
 const service=new DelegationService({...f.options,tools:()=>({...original,call:async(c,t,a)=>t==="read_thread"?{thread:{status:{type:"notLoaded"}},turns:[{id:"old",status:"completed",items:[]}]}:original.call(c,t,a)})});
 await service.tick();f.advance();await service.tick();assert.equal(f.sent.length,1);assert.equal(f.store.all()[0]?.status,"running");
 }finally{f.db.close();}
});

for(const [label,status,turns] of [
 ["unloaded with active turn","notLoaded",[{id:"active",status:"inProgress"}]],
 ["idle with active turn","idle",[{id:"active",status:"inProgress"}]],
 ["unknown status",undefined,[]],
 ["approval wait","active",[{id:"active",status:"inProgress"}]],
] as const)test(`unsafe Desktop state stays queued: ${label}`,async()=>{
 const f=fixture();try{await f.submit();const original=f.options.tools();const service=new DelegationService({...f.options,tools:()=>({...original,call:async(c,t,a)=>t==="read_thread"?{thread:{status:{type:status}},turns}:original.call(c,t,a)})});await service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.all()[0]?.status,"queued");}finally{f.db.close();}
});

test("unloaded target becoming busy at final probe is not sent",async()=>{
 const f=fixture();try{await f.submit();const original=f.options.tools();let reads=0;const service=new DelegationService({...f.options,tools:()=>({...original,call:async(c,t,a)=>t==="read_thread"?{thread:{status:{type:++reads===1?"notLoaded":"active"}},turns:[]}:original.call(c,t,a)})});await service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.all()[0]?.status,"queued");}finally{f.db.close();}
});

test("pronoun follow-up delegates to the unique recent target in the same source chat",async()=>{
 const f=fixture();try{await f.submit();const old=f.store.all()[0]!;old.status="delivered";f.store.save(old);
 const result=JSON.parse(await f.service.command({...f.context,turnId:"follow-up"},{action:"submit",target:"验收会话",instruction:"检查后推送远端并返回结果"},{...f.source,text:"告诉它让它推送远端"}));
 assert.equal(result.status,"queued");assert.equal(f.store.all().length,2);assert.equal(f.store.all()[1]?.target,old.target);await f.service.tick();assert.equal(f.sent.length,1);assert.match(String(f.sent[0]?.prompt),/告诉它让它推送远端/);
 }finally{f.db.close();}
});

test("pronoun target argument is resolved from stored context, not searched as a title",async()=>{
 const f=fixture();try{await f.submit();const service=new DelegationService({...f.options,resolve:async()=>{throw Error("Must not search a pronoun");}});const r=JSON.parse(await service.command({...f.context,turnId:"next"},{action:"submit",target:"它",instruction:"推送"},{...f.source,text:"告诉它推送"}));assert.equal(r.target,"验收会话");}finally{f.db.close();}
});
test("follow-up cannot borrow another channel or source chat, nor trust a model-suggested target",async()=>{
 const f=fixture();try{await f.submit();for(const context of [{...f.context,threadId:"other",turnId:"next"}]){const r=JSON.parse(await f.service.command(context,{action:"submit",target:"验收会话",instruction:"推送"},{...f.source,text:"告诉它推送"}));assert.equal(r.status,"needs_confirmation");assert.equal(f.store.all().length,1);}const s=new DelegationService({...f.options,account:"secondary"});const r=JSON.parse(await s.command({...f.context,turnId:"next"},{action:"submit",target:"验收会话",instruction:"推送"},{...f.source,text:"告诉它推送"}));assert.equal(r.status,"needs_confirmation");}finally{f.db.close();}
});
test("ambiguous follow-up persists its task, confirms a named candidate and is idempotent",async()=>{
 const f=fixture();try{await f.submit();const old=f.store.all()[0]!;f.store.save({...old,id:"other-job",turnId:"other-turn",target:"other-target",title:"另一个会话"});
 const r=JSON.parse(await f.service.command({...f.context,turnId:"follow"},{action:"submit",target:"验收会话",instruction:"检查后推送"},{...f.source,text:"告诉它推送"}));assert.equal(r.status,"needs_confirmation");assert.match(r.question,/哪个会话/);assert.equal(f.store.all().length,2);
 const service=new DelegationService(f.options);const context={...f.context,turnId:"confirm-turn"};const args={action:"confirm",instruction:"模型不应替换原任务"};const source={...f.source,text:"是验收会话"};
 const yes=JSON.parse(await service.command(context,args,source));const again=JSON.parse(await service.command(context,args,source));assert.equal(yes.id,again.id);assert.equal(f.store.all().length,3);assert.equal(f.store.all()[2]?.instruction,"检查后推送");assert.match(f.store.all()[2]?.userText??"",/告诉它推送/);
 await assert.rejects(service.command({...context,turnId:"later"},args,source),/没有有效/);
 }finally{f.db.close();}
});
test("yes alone cannot choose between multiple candidates",async()=>{
 const f=fixture();try{await f.submit();f.store.save({...f.store.all()[0]!,id:"other-job",turnId:"other-turn",target:"other-target",title:"另一个会话"});await f.service.command({...f.context,turnId:"follow"},{action:"submit",instruction:"推送"},{...f.source,text:"告诉它推送"});const r=JSON.parse(await f.service.command({...f.context,turnId:"confirm"},{action:"confirm",target:"验收会话"},{...f.source,text:"是"}));assert.equal(r.status,"needs_confirmation");assert.equal(f.store.all().length,2);}finally{f.db.close();}
});
test("no recent target keeps the task until the user supplies its name",async()=>{
 const f=fixture();try{const r=JSON.parse(await f.service.command(f.context,{action:"submit",instruction:"推送远端"},{...f.source,text:"告诉它推送远端"}));assert.equal(r.status,"needs_confirmation");const yes=JSON.parse(await new DelegationService(f.options).command({...f.context,turnId:"confirm"},{action:"confirm",target:"验收会话"},{...f.source,text:"验收会话"}));assert.equal(yes.status,"queued");assert.equal(f.store.all()[0]?.instruction,"推送远端");}finally{f.db.close();}
});
test("expired, revoked and stale follow-up requests cannot create jobs",async()=>{
 const f=fixture();try{await f.submit();const old=f.store.all()[0]!;f.store.save({...old,createdAt:-24*60*60_000});let r=JSON.parse(await f.service.command({...f.context,turnId:"next"},{action:"submit",instruction:"推送"},{...f.source,text:"告诉它推送"}));assert.equal(r.status,"needs_confirmation");
 await assert.rejects(f.service.command({...f.context,turnId:"confirm"},{action:"confirm",target:"验收会话"},{...f.source,text:"验收会话",isLive:()=>false}),/失效/);assert.equal(f.store.all().length,1);
 const s=new DelegationService({...f.options,now:()=>10000+11*60_000});await assert.rejects(s.command({...f.context,turnId:"confirm"},{action:"confirm",target:"验收会话"},{...f.source,text:"验收会话"}),/没有有效/);
 const revoked=new DelegationService({...f.options,owner:()=>"secondary",explicitOwner:()=>"secondary"});r=JSON.parse(await revoked.command({...f.context,turnId:"revoked"},{action:"submit",instruction:"推送"},{...f.source,text:"告诉它推送"}));assert.equal(r.status,"needs_confirmation");assert.equal(f.store.all().length,1);
 }finally{f.db.close();}
});

test("confirmation cannot turn a refusal or a changed task into authorization",async()=>{
 const f=fixture();try{await f.service.command(f.context,{action:"submit",instruction:"推送"},{...f.source,text:"告诉它推送"});for(const text of ["不是验收会话","是验收会话，但不要推送","验收会话，换成删除文件"]){await assert.rejects(f.service.command({...f.context,turnId:"confirm"},{action:"confirm",target:"验收会话"},{...f.source,text}),/确认候选/);}assert.equal(f.store.all().length,0);}finally{f.db.close();}
});

test("a recent target does not authorize a capability question or a declined delegation", async () => {
  const f = fixture();
  try {
    await f.service.command(f.context, { action: "inspect", target: "验收会话" }, f.source);
    for (const text of ["你支持跨会话委派吗？", "先不要告诉它执行，等我确认", "这句‘告诉它执行验收’是什么意思？"]) {
      await assert.rejects(f.service.command({ ...f.context, turnId: "later" }, {
        action: "submit", instruction: "执行验收",
      }, { ...f.source, text }), /授权/);
    }
    const result = JSON.parse(await f.service.command({ ...f.context, turnId: "send" }, {
      action: "submit", instruction: "执行验收",
    }, { ...f.source, text: "把这个要求直接发给那个会话吧" }));
    assert.equal(result.targetId, "target");
    assert.equal(f.store.all().length, 1);
    assert.equal(f.sent.length, 0);
  } finally { f.db.close(); }
});

test("an incomplete response does not confirm a pending delegation", async () => {
  const f = fixture();
  try {
    f.store.savePending("primary", f.context.threadId, {
      candidates: [{ id: "target", title: "验收会话" }],
      instruction: "执行验收", userText: "告诉它执行验收", createdAt: 10000,
    });
    for (const text of ["？", "是否？", "好的呢？"]) {
      const result = JSON.parse(await f.service.command(f.context, { action: "confirm" }, { ...f.source, text }));
      assert.equal(result.status, "needs_confirmation");
    }
    assert.equal(f.store.all().length, 0);
  } finally { f.db.close(); }
});

test("pending follow-up survives SQLite close and reopen",async()=>{
 const f=fixture();let db:DatabaseSync|undefined;try{await f.submit();const path=join(f.options.root,"followups.sqlite");db=new DatabaseSync(path);let store=new DelegationStore(db);const old=f.store.all()[0]!;store.save(old);store.save({...old,id:"other-job",turnId:"other-turn",target:"other-target",title:"另一个会话"});await new DelegationService({...f.options,store}).command({...f.context,turnId:"follow"},{action:"submit",instruction:"推送并返回结果"},{...f.source,text:"告诉它推送"});db.close();db=new DatabaseSync(path);store=new DelegationStore(db);await new DelegationService({...f.options,store}).command({...f.context,turnId:"confirm"},{action:"confirm"},{...f.source,text:"是验收会话"});assert.equal(store.all().at(-1)?.instruction,"推送并返回结果");assert.equal(store.all().length,3);}finally{db?.close();f.db.close();}
});

test("read-only Desktop inspection returns current evidence without submitting tasks",async()=>{
 const f=fixture();try{const r=JSON.parse(await f.service.command(f.context,{action:"inspect",target:"验收会话"},{...f.source,text:"查一下现在电脑会话任务进度"}));assert.equal(r.status,"observed");assert.equal(r.target.id,"target");assert.equal(f.sent.length,0);assert.equal(f.store.all().length,0);assert.equal(f.closed(),1);}finally{f.db.close();}
});

test("secondary inspection requires authorization before reading and does not leak candidates",async()=>{
 const f=fixture();try{let resolved=0;const s=new DelegationService({...f.options,account:"secondary",resolve:async()=>{resolved++;return [{id:"target",title:"private title"}];}});const denied=JSON.parse(await s.command(f.context,{action:"inspect",target:"11111111-1111-1111-1111-111111111111"},f.source));assert.equal(denied.status,"permission_required");assert.equal(resolved,0);assert.equal(f.reads(),0);assert.equal(f.sent.length,0);}finally{f.db.close();}
});

test("bare inspect and project inspect report live activity without searching the title catalog", async () => {
  const f = fixture();
  try {
    const rows = [
      { id: "other-project", title: "其他项目", hostId: "local", cwd: "D:\\Other", status: "active" },
      { id: "origin", title: "查询自身", hostId: "local", cwd: "D:\\Fixture", status: "active" },
      { id: "foreign", title: "不属于本通道", hostId: "local", cwd: "D:\\Fixture", status: "active" },
      { id: "target", title: "当前任务", hostId: "local", cwd: "d:/worktree/", projectId: "fixture-project", status: "active", summary: "不要转发正文" },
      { id: "old", title: "旧任务", hostId: "local", cwd: "D:\\Fixture", status: "notLoaded" },
    ];
    const service = new DelegationService({
      ...f.options,
      resolve: async () => { throw new Error("catalog is not an activity source"); },
      tools: () => ({
        async call(_context, tool) {
          if (tool === "list_projects") return {
            projects: [{ projectKind: "local", hostId: "local", label: "Fixture", path: "D:\\Fixture", projectId: "fixture-project" }],
          };
          assert.equal(tool, "list_threads");
          return { threads: rows, nextCursor: null };
        },
        close() {},
      }),
    });
    const source = { ...f.source, text: "看下当前是否还有会话在执行任务？" };
    const all = JSON.parse(await service.command(f.context, { action: "inspect" }, source));
    assert.equal(all.status, "active");
    assert.deepEqual(all.sessions.map((t: { id: string }) => t.id), ["other-project", "target"]);
    const project = JSON.parse(await service.command(f.context, { action: "inspect", project: "Fixture" }, source));
    assert.deepEqual(project.sessions, [{ id: "target", title: "当前任务" }]);
    assert.equal(project.project, "Fixture");
    const catalog = JSON.parse(await service.command(f.context, { action: "sessions", project: "Fixture" }, {
      ...source, text: "列出 Fixture 项目下的会话名称和 ID",
    }));
    assert.equal(catalog.status, "listed");
    assert.deepEqual(catalog.sessions, [
      { id: "target", title: "当前任务" },
      { id: "old", title: "旧任务" },
    ]);
    const missing = JSON.parse(await service.command(f.context, { action: "activity", project: "Typo" }, source));
    assert.equal(missing.status, "project_unresolved");
    assert.equal(f.store.all().length, 0);
  } finally { f.db.close(); }
});

test("activity preserves verified results on partial pages without exposing other channels", async () => {
  const f = fixture();
  try {
    const cursors: unknown[] = [];
    const service = new DelegationService({
      ...f.options,
      activeBridgeThreads: () => ["origin", "bridge-work", "foreign"],
      tools: () => ({
        async call(_context, tool, args) {
          assert.equal(tool, "list_threads");
          cursors.push(args.cursor);
          if (args.cursor) throw new Error("Desktop disconnected");
          return {
            threads: [
              { id: "target", title: "已核实的活动任务", hostId: "local", status: "active" },
              { id: "foreign", title: "其他通道", hostId: "local", status: "active" },
              { id: "remote", title: "外部主机", hostId: "host-2", status: "active" },
            ],
            nextCursor: "next",
          };
        },
        close() {},
      }),
    });
    const result = JSON.parse(await service.command(f.context, { action: "activity" }, f.source));
    assert.equal(result.status, "active");
    assert.equal(result.desktopCoverage, "partial");
    assert.deepEqual(result.sessions, [{ id: "target", title: "已核实的活动任务" }, { id: "bridge-work" }]);
    assert.deepEqual(cursors, [undefined, "next"]);
    const unavailable = new DelegationService({
      ...f.options,
      tools: () => { throw new Error("Desktop unavailable"); },
    });
    const failed = JSON.parse(await unavailable.command(f.context, { action: "activity" }, f.source));
    assert.equal(failed.status, "unavailable");
    assert.deepEqual(failed.sessions, []);
    assert.equal(f.store.all().length, 0);
  } finally { f.db.close(); }
});
test("explicit read-only Desktop grants never grant delegation or another account's owned thread",async()=>{
 const f=fixture();try{writeFileSync(join(f.options.root,"delegation-permissions.json"),JSON.stringify({version:1,accounts:{secondary:{allowDesktopReadThreads:["target","foreign"]}}}));const s=new DelegationService({...f.options,account:"secondary"});assert.equal(s.canRead("target"),true);assert.equal(s.allowed("target"),false);const r=JSON.parse(await s.command(f.context,{action:"inspect",target:"验收会话"},f.source));assert.equal(r.status,"observed");assert.equal(f.sent.length,0);assert.equal(f.store.all().length,0);const strict=new DelegationService({...f.options,account:"secondary",explicitOwner:()=>"primary"});assert.equal(strict.canRead("target"),false);}finally{f.db.close();}
});

test("a follow-up to a recently inspected read-only target reports the missing delegation grant", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.options.root, "delegation-permissions.json"), JSON.stringify({
      version: 1, accounts: { secondary: { allowDesktopReadThreads: ["target"] } },
    }));
    const service = new DelegationService({ ...f.options, account: "secondary" });
    const inspection = JSON.parse(await service.command(f.context, { action: "inspect", target: "验收会话" }, f.source));
    assert.equal(inspection.target.id, "target");
    const result = JSON.parse(await service.command({ ...f.context, turnId: "follow-up" }, {
      action: "submit", instruction: "执行验收",
    }, { ...f.source, text: "告诉它执行验收" }));
    assert.equal(result.status, "permission_required");
    assert.match(result.note, /只读/);
    assert.equal(f.store.all().length, 0);
    assert.equal(f.sent.length, 0);
  } finally { f.db.close(); }
});

test("both enabled channels can delegate to a new unassigned Desktop target without sharing private chats or receipts", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.options.root, "delegation-permissions.json"), JSON.stringify({
      version: 1,
      accounts: {
        primary: { allowUnassignedDesktopThreads: true },
        secondary: { allowUnassignedDesktopThreads: true },
      },
    }));
    const explicitOwner = (id: string) => id === "primary-private" ? "primary" :
      id === "secondary-private" ? "secondary" : undefined;
    const options = {
      ...f.options,
      explicitOwner,
      owner: (id: string) => explicitOwner(id) ?? "primary",
    };
    const primary = new DelegationService(options);
    const secondary = new DelegationService({ ...options, account: "secondary" });
    const context = { threadId: "secondary-private", turnId: "secondary-turn" };
    assert.equal(secondary.canRead("primary-private"), false);
    assert.equal(primary.allowed("secondary-private"), false);
    const inspection = JSON.parse(await secondary.command(context, { action: "inspect", target: "验收会话" }, f.source));
    assert.equal(inspection.target.id, "target");
    const submitted = JSON.parse(await secondary.command(context, {
      action: "submit", target: "验收会话", instruction: "只执行验收",
    }, f.source));
    assert.equal(submitted.status, "queued");
    assert.equal(submitted.targetId, "target");
    assert.deepEqual(JSON.parse(await primary.command(f.context, { action: "status", jobId: submitted.id }, f.source)), []);
    await secondary.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]?.threadId, "target");
    assert.equal(JSON.parse(await secondary.command(context, { action: "status", jobId: submitted.id }, f.source))[0]?.status, "running");
  } finally { f.db.close(); }
});
test("inspection rejects stale sources and discards results if access is revoked mid-query",async()=>{
 const f=fixture();try{await assert.rejects(f.service.command(f.context,{action:"inspect"},{...f.source,isLive:()=>false}),/失效/);assert.equal(f.reads(),0);let revoked=false;const tools=f.options.tools();const s=new DelegationService({...f.options,owner:()=>revoked?"secondary":"primary",explicitOwner:()=>revoked?"secondary":undefined,tools:()=>({...tools,call:async(c,t,a)=>{const r=await tools.call(c,t,a);revoked=true;return r;}})});await assert.rejects(s.command(f.context,{action:"inspect",target:"验收会话"},f.source),/撤销/);assert.equal(f.sent.length,0);assert.equal(f.closed(),1);}finally{f.db.close();}
});

test("large Desktop progress uses bounded inspection without loading full turns",async()=>{const f=fixture();try{let reads=0;const s=new DelegationService({...f.options,tools:()=>{throw Error("oversized Desktop turns must not be requested");},readInspection:async()=>{reads++;return {thread:{status:{type:"notLoaded"}},history:{messages:[{role:"assistant",text:"最新进度",timestamp:"2026-10-27T07:00:00Z"}],window:{partial:true,nextBeforeBytes:100}}};}});const r=JSON.parse(await s.command(f.context,{action:"inspect",target:"验收会话"},f.source));assert.equal(reads,1);assert.equal(r.status,"observed");assert.equal(r.history.messages[0].text,"最新进度");assert.equal(r.statusSource,"independent-read-only-observer");assert.equal(f.sent.length,0);}finally{f.db.close();}});


test("project candidates keep timestamps but never expose another channel or dispatch work", async () => {
  const f = fixture();
  try {
    const service = new DelegationService({ ...f.options, resolve: selector => resolveDelegationTargets(selector, [{ name: "Fixture", cwd: "D:\\Fixture" }], async () => ({ data: [{ id: "foreign", name: "另一通道", updatedAt: 30 }, { id: "target", name: "任务甲", updatedAt: 20 }, { id: "allowed-two", name: "任务乙", updatedAt: 10 }], nextCursor: null })) });
    const response = JSON.parse(await service.command(f.context, { action: "inspect", target: "Fixture" }, { ...f.source, text: "看看Fixture最近会话" }));
    assert.equal(response.status, "needs_target");
    assert.deepEqual(response.candidates.map((x: { id: string; updatedAt: number }) => ({ id: x.id, updatedAt: x.updatedAt })), [{ id: "target", updatedAt: 20 }, { id: "allowed-two", updatedAt: 10 }]);
    assert.doesNotMatch(JSON.stringify(response), /另一通道|foreign/);
    assert.equal(f.sent.length, 0); assert.equal(f.reads(), 0);
  } finally { f.db.close(); }
});


test("inspection carries its unique target into a natural follow-up delegation", async()=>{
 const f=fixture();try{await f.service.command(f.context,{action:"inspect",target:"验收会话"},{...f.source,text:"查看验收会话"});
 const r=JSON.parse(await f.service.command({...f.context,turnId:"follow"},{action:"submit",target:"target",instruction:"更新测试环境"},{...f.source,text:"可以，你安排委托，让它更新测试环境"}));assert.equal(r.status,"queued");assert.equal(f.store.all().length,1);
 }finally{f.db.close();}
});
test("background reconciliation uses small bounded reads and retains a send turn receipt",async()=>{
 const f=fixture();try{await f.submit();const base=f.options.tools();const service=new DelegationService({...f.options,tools:()=>({...base,call:async(c,t,a)=>{if(t==="read_thread"){assert.equal(a.turnLimit,1);assert.ok(Number(a.maxOutputCharsPerItem)<=2000);return {thread:{status:{type:"idle"}},turns:[]};}return {...await base.call(c,t,a),turnId:"sent-turn"};}})});await service.tick();assert.equal(f.store.all()[0]?.targetTurn,"sent-turn");}finally{f.db.close();}
});
test("natural cancellation cancels the current queued delegation without copying its id",async()=>{
 const f=fixture();try{await f.submit();const r=JSON.parse(await f.service.command({...f.context,turnId:"cancel"},{action:"cancel"},{...f.source,text:"然后把你的委托给我关停"}));assert.equal(r[0].status,"cancelled");await f.service.tick();assert.equal(f.sent.length,0);}finally{f.db.close();}
});
test("retry advances the existing queued job once instead of creating a second delegation",async()=>{
 const f=fixture();try{await f.submit();const r=JSON.parse(await f.service.command({...f.context,turnId:"retry"},{action:"retry"},{...f.source,text:"那你能否让他开始执行呢？"}));assert.equal(r.status,"running");assert.equal(f.store.all().length,1);assert.equal(f.sent.length,1);}finally{f.db.close();}
});

test("listing sessions does not mask an explicitly selected delegation from retry", async () => {
  const f = fixture();
  try {
    const job = JSON.parse(await f.submit());
    await f.service.command(f.context, { action: "activity" }, f.source);
    const result = JSON.parse(await f.service.command({ ...f.context, turnId: "urge" }, {
      action: "retry", jobId: job.id,
    }, { ...f.source, text: "请催办这项委派" }));
    assert.equal(result.id, job.id);
    assert.equal(result.status, "running");
    assert.equal(f.sent.length, 1);
  } finally { f.db.close(); }
});

test("same-target serialization does not expose another channel's delegation record", async () => {
  const f = fixture();
  try {
    const primary = JSON.parse(await f.submit());
    writeFileSync(join(f.options.root, "delegation-permissions.json"), JSON.stringify({
      version: 1, accounts: { secondary: { allowUnassignedDesktopThreads: true } },
    }));
    const secondary = new DelegationService({ ...f.options, account: "secondary" });
    const context = { threadId: "secondary-origin", turnId: "secondary-turn" };
    const job = JSON.parse(await secondary.command(context, {
      action: "submit", target: "验收会话", instruction: "核对合成资料",
    }, f.source));
    await secondary.tick();
    const [result] = JSON.parse(await secondary.command(context, { action: "status", jobId: job.id }, f.source));
    assert.equal(result.id, job.id);
    assert.equal(result.status, "queued");
    assert.match(result.issue, /等待/);
    assert.ok(!result.issue.includes(primary.id));
    assert.equal(f.sent.length, 0);
  } finally { f.db.close(); }
});


test("unknown sends stay single even when explicitly urged, and cancellation cannot cross source chats",async()=>{
 const f=fixture();try{await f.submit();f.failSend();await f.service.tick();f.advance();await f.service.command({...f.context,turnId:"urge"},{action:"retry"},{...f.source,text:"催办一下"});assert.equal(f.sent.length,1);await assert.rejects(f.service.command(f.context,{action:"cancel",jobId:f.store.all()[0]!.id},{...f.source,text:"取消 "+f.store.all()[0]!.id}),/尚未投递/);}finally{f.db.close();}
});
test("a natural affirmative can continue a unique stored task without replacing its instruction",async()=>{
 const f=fixture();try{const service=new DelegationService({...f.options,resolve:async()=>[]});await service.command(f.context,{action:"submit",instruction:"原始测试任务"},{...f.source,text:"告诉它做测试"});f.store.savePending("primary","origin",{candidates:[{id:"target",title:"验收会话"}],instruction:"原始测试任务",userText:"告诉它做测试",createdAt:10000});const r=JSON.parse(await service.command({...f.context,turnId:"confirm"},{action:"confirm",instruction:"模型改写任务"},{...f.source,text:"那你能否让他开始执行呢？"}));assert.equal(r.status,"queued");assert.equal(f.store.all()[0]!.instruction,"原始测试任务");}finally{f.db.close();}
});
test("old result markers can be reconciled through bounded cursor pages",async()=>{
 const f=fixture();try{await f.submit();await f.service.tick();const j=f.store.all()[0]!;let page=0;const base=f.options.tools();const service=new DelegationService({...f.options,tools:()=>({...base,call:async(_c,_t,args)=>{assert.equal(args.turnLimit,1);page++;return page===1?{thread:{status:{type:"idle"}},turns:[{id:"newer",status:"completed",items:[]}],page:{nextCursor:"older"}}:{thread:{status:{type:"idle"}},turns:[{id:"finished",status:"completed",items:[{type:"agentMessage",phase:"final_answer",text:`[iLink委派:${j.id}] RESULT_OK`}]}]};}})});await service.tick();f.advance();await service.tick();assert.equal(f.store.all()[0]!.status,"completed");}finally{f.db.close();}
});


test("an upgrade-held legacy job stays unsent until a natural retry or cancellation",async()=>{
 const f=fixture();try{await f.submit();const job=f.store.all()[0]!;job.held=true;f.store.save(job);await f.service.tick();assert.equal(f.sent.length,0);f.advance();const r=JSON.parse(await f.service.command({...f.context,turnId:"resume-held"},{action:"retry"},{...f.source,text:"继续执行这个委托"}));assert.equal(r.status,"running");assert.equal(f.sent.length,1);}finally{f.db.close();}
});


test("a concrete model target cannot be silently replaced by an older pronoun target",async()=>{
 const f=fixture();try{await f.submit();await assert.rejects(f.service.command({...f.context,turnId:"new-request"},{action:"submit",target:"22222222-2222-4222-8222-222222222222",instruction:"检查服务一致性"},{...f.source,text:"找项目最近执行过的会话，告诉它检查服务一致性"}),/目标|定位/);assert.equal(f.store.all().length,1);}finally{f.db.close();}
});
test("a uniquely most recently active project target binds inspection, submission and receipt",async()=>{
 const f=fixture();try{await f.submit();const id="22222222-2222-4222-8222-222222222222";const service=new DelegationService({...f.options,resolve:async()=>[{id,title:"服务核查",updatedAt:20},{id:"older",title:"旧项目任务",updatedAt:10}]});const text="找Fixture项目最近执行过的会话，告诉它检查服务一致性";const observed=JSON.parse(await service.command(f.context,{action:"inspect",target:"Fixture"},{...f.source,text}));assert.equal(observed.status,"observed");assert.equal(observed.target.id,id);const result=JSON.parse(await service.command({...f.context,turnId:"new-request"},{action:"submit",target:id,instruction:"检查服务一致性"},{...f.source,text}));assert.equal(result.targetId,id);assert.equal(f.store.all().at(-1)!.target,id);}finally{f.db.close();}
});
test("a concrete id conflicting with the fresh observed target is rejected",async()=>{
 const f=fixture();try{await f.service.command(f.context,{action:"inspect",target:"验收会话"},f.source);await assert.rejects(f.service.command({...f.context,turnId:"new-request"},{action:"submit",target:"22222222-2222-4222-8222-222222222222",instruction:"检查"},{...f.source,text:"告诉它检查"}),/目标|定位/);assert.equal(f.store.all().length,0);}finally{f.db.close();}
});
test("a Desktop snapshot for another thread cannot authorize dispatch",async()=>{
 const f=fixture();try{await f.submit();const base=f.options.tools();const service=new DelegationService({...f.options,tools:()=>({...base,call:async(c,t,a)=>t==="read_thread"?{thread:{id:"different",status:{type:"idle"}},turns:[]}:base.call(c,t,a)})});await service.tick();assert.equal(f.sent.length,0);assert.match(f.store.all()[0]!.issue!,/TARGET_MISMATCH/);}finally{f.db.close();}
});


test("a fresh ambiguous activity query invalidates older delegation references",async()=>{
 const f=fixture();try{await f.submit();const service=new DelegationService({...f.options,resolve:async()=>[{id:"new-a",title:"任务甲",updatedAt:20},{id:"new-b",title:"任务乙",updatedAt:20}]});const r=JSON.parse(await service.command(f.context,{action:"inspect",target:"Fixture"},{...f.source,text:"找Fixture最近活动的会话"}));assert.equal(r.status,"needs_target");const submitted=JSON.parse(await service.command({...f.context,turnId:"new"},{action:"submit",instruction:"核查"},{...f.source,text:"告诉它核查"}));assert.equal(submitted.status,"needs_confirmation");assert.equal(f.store.all().length,1);}finally{f.db.close();}
});
