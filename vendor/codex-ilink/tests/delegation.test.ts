import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,mkdirSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DelegationStore,DelegationService,type DelegationJob} from "../src/delegation/delegation-service.ts";
import {discoverDesktopTools,type DesktopTools} from "../src/delegation/desktop-tools.ts";
import {selectDelegationTargets} from "../src/delegation/catalog.ts";

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

test("pending follow-up survives SQLite close and reopen",async()=>{
 const f=fixture();let db:DatabaseSync|undefined;try{await f.submit();const path=join(f.options.root,"followups.sqlite");db=new DatabaseSync(path);let store=new DelegationStore(db);const old=f.store.all()[0]!;store.save(old);store.save({...old,id:"other-job",turnId:"other-turn",target:"other-target",title:"另一个会话"});await new DelegationService({...f.options,store}).command({...f.context,turnId:"follow"},{action:"submit",instruction:"推送并返回结果"},{...f.source,text:"告诉它推送"});db.close();db=new DatabaseSync(path);store=new DelegationStore(db);await new DelegationService({...f.options,store}).command({...f.context,turnId:"confirm"},{action:"confirm"},{...f.source,text:"是验收会话"});assert.equal(store.all().at(-1)?.instruction,"推送并返回结果");assert.equal(store.all().length,3);}finally{db?.close();f.db.close();}
});
