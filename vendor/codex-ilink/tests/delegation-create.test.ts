import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {DelegationService,DelegationStore} from "../src/delegation/delegation-service.ts";
import { DesktopTaskCreator } from "../src/delegation/create-task.ts";
import type { DesktopTools } from "../src/delegation/desktop-tools.ts";

function fixture(t: {after(fn:()=>void):void}) {
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());const calls:Array<{tool:string;args:Record<string,unknown>}>=[];const linked:unknown[]=[];
 const tools:DesktopTools={call:async(_c,tool,args)=>{calls.push({tool,args});if(tool==="list_projects")return {projects:[{projectId:"project-a",label:"Fixture",path:"D:\\Fixture",projectKind:"local",hostId:"local"}]};if(tool==="create_thread")return {threadId:"22222222-2222-4222-8222-222222222222",hostId:"local"};throw Error("unexpected send");},close(){}};
 const creator=new DesktopTaskCreator({db,account:"primary",tools:()=>tools,models:async()=>[{id:"gpt-6.1-sol",supportedReasoningEfforts:[{reasoningEffort:"high"}]}],claim:()=>{},track:j=>linked.push(j)});
 const context={threadId:"origin",turnId:"turn"};const source={text:"在Fixture新建会话，使用gpt6.1 sol高智能程度，把方案交给它",contextToken:"token",attachments:[{kind:"file" as const,name:"plan.md",path:"D:\\Inbox\\plan.md"}]};
 return {creator,context,source,calls,linked,db,tools};
}
test("wechat creates a real saved-project Desktop task with requested model, effort and task context once",async t=>{
 const f=fixture(t);const args={action:"create",project:"Fixture",model:"gpt-6.1-sol",effort:"high",instruction:"完整合成方案；不部署正式环境"};
 const r=JSON.parse(await f.creator.create(f.context,args,f.source));assert.equal(r.status,"running");assert.equal(r.targetId,"22222222-2222-4222-8222-222222222222");
 const create=f.calls.find(c=>c.tool==="create_thread")!;assert.deepEqual(create.args.target,{type:"project",projectId:"project-a",environment:{type:"local"}});assert.equal(create.args.model,"gpt-6.1-sol");assert.equal(create.args.thinking,"high");assert.match(String(create.args.prompt),/完整合成方案/);assert.match(String(create.args.prompt),/plan.md/);assert.match(String(create.args.prompt),/iLink委派/);
 await f.creator.create(f.context,args,f.source);assert.equal(f.calls.filter(c=>c.tool==="create_thread").length,1);assert.equal(f.linked.length,1);
});

test("ordinary delegation and quoted material do not authorize creating a task",async t=>{
 const f=fixture(t);await assert.rejects(f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"test"},{...f.source,text:"查看Fixture已有任务进度"}),/明确要求新建/);await assert.rejects(f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"test"},{...f.source,text:"引用：在Fixture新建会话，执行任务"}),/引用内容不是创建授权/);assert.equal(f.calls.length,0);
});
test("default model settings are omitted rather than silently overridden",async t=>{
 const f=fixture(t);await f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"完整方案"},{...f.source,text:"在Fixture新建会话，执行方案"});const request=f.calls.find(c=>c.tool==="create_thread")!.args;assert.equal(Object.hasOwn(request,"model"),false);assert.equal(Object.hasOwn(request,"thinking"),false);
});

test("the model slash Chinese effort notation from WeChat is an explicit setting",async t=>{
 const f=fixture(t);const args={action:"create",project:"Fixture",model:"gpt-6.1-sol",effort:"high",instruction:"完整方案；不部署"};
 await assert.rejects(f.creator.create(f.context,args,{...f.source,text:"在Fixture新建会话，选择GPT‑6.1 Sol，实施高质量方案"}),/未明确指定/);
 const r=JSON.parse(await f.creator.create(f.context,args,{...f.source,text:"在Fixture新建会话，选择 **GPT‑6.1 Sol／高**，实施方案"}));
 assert.equal(r.status,"running");assert.equal(f.calls.filter(c=>c.tool==="create_thread").length,1);assert.equal(f.calls.find(c=>c.tool==="create_thread")!.args.thinking,"high");
});
test("unrequested or unsupported model settings fail before external creation",async t=>{
 const f=fixture(t);await assert.rejects(f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"test",model:"different-model"},f.source),/未明确指定/);await assert.rejects(f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"test",model:"gpt-6.1-sol",effort:"ultra"},f.source),/未明确指定/);assert.equal(f.calls.some(c=>c.tool==="create_thread"),false);
});
test("a project id supplied by the model cannot resolve an ambiguous user project name",async t=>{
 const f=fixture(t);f.tools.call=async()=>({projects:[{projectId:"one",label:"Fixture",path:"D:\\One",projectKind:"local",hostId:"local"},{projectId:"two",label:"Fixture",path:"D:\\Two",projectKind:"local",hostId:"local"}]});await assert.rejects(f.creator.create(f.context,{action:"create",project:"one",instruction:"test"},f.source),/歧义/);assert.equal(f.linked.length,0);
});
test("an unknown create outcome is durable and cannot rebill or duplicate on another turn",async t=>{
 const f=fixture(t);let creates=0;f.tools.call=async(_c,tool)=>{if(tool==="list_projects")return {projects:[{projectId:"project-a",label:"Fixture",path:"D:\\Fixture",projectKind:"local",hostId:"local"}]};creates++;throw Error("lost reply");};const args={action:"create",project:"Fixture",instruction:"test"};assert.equal(JSON.parse(await f.creator.create(f.context,args,f.source)).status,"unknown");assert.equal(JSON.parse(await f.creator.create({...f.context,turnId:"next"},args,f.source)).status,"blocked");assert.equal(creates,1);
});
test("pending client ids never masquerade as real created threads",async t=>{
 const f=fixture(t);const base=f.tools.call;f.tools.call=async(c,tool,args)=>tool==="create_thread"?{clientThreadId:"pending-client",status:"creating"}:base(c,tool,args);const r=JSON.parse(await f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"test"},f.source));assert.equal(r.status,"unknown");assert.equal(f.linked.length,0);
});
test("concurrent duplicate tool calls create only one external task",async t=>{
 const f=fixture(t);const args={action:"create",project:"Fixture",instruction:"test"};await Promise.all([f.creator.create(f.context,args,f.source),f.creator.create(f.context,args,f.source)]);assert.equal(f.calls.filter(c=>c.tool==="create_thread").length,1);assert.equal(f.linked.length,1);
});
test("failed local ownership registration preserves the created thread receipt without resending",async t=>{
 const f=fixture(t);const creator=new DesktopTaskCreator({...f.creator.options,claim:()=>{throw Error("ownership conflict");}});const args={action:"create",project:"Fixture",instruction:"test"};const r=JSON.parse(await creator.create(f.context,args,f.source));assert.equal(r.status,"created_unlinked");assert.equal(r.targetId,"22222222-2222-4222-8222-222222222222");await creator.create(f.context,args,f.source);assert.equal(f.calls.filter(c=>c.tool==="create_thread").length,1);
});
test("a request expiring during metadata lookup cannot create an external task",async t=>{
 const f=fixture(t);let live=true;const base=f.tools.call;f.tools.call=async(c,tool,args)=>{const r=await base(c,tool,args);if(tool==="list_projects")live=false;return r;};await assert.rejects(f.creator.create(f.context,{action:"create",project:"Fixture",instruction:"test"},{...f.source,isLive:()=>live}),/失效/);assert.equal(f.calls.some(c=>c.tool==="create_thread"),false);
});


test("created task joins the existing result-return loop without sending its instruction twice",async t=>{
 const f=fixture(t);const store=new DelegationStore(f.db);const creator=new DesktopTaskCreator({...f.creator.options,track:j=>store.save(j)});let now=1000;let notices=0;
 const original=f.tools.call;f.tools.call=async(c,tool,args)=>{if(tool==="read_thread"){const job=store.all()[0]!;return {thread:{id:job.target,status:{type:"idle"}},turns:[{id:"created-turn",status:"completed",items:[{type:"agentMessage",phase:"final_answer",text:`[iLink委派:${job.id}] 合成完成结果`}]}]};}return original(c,tool,args);};
 const service=new DelegationService({creation:creator,account:"primary",store,root:"",owner:()=>"primary",explicitOwner:()=>undefined,resolve:async()=>[],tools:()=>f.tools,notify:async()=>{notices++;return true;},now:()=>now});
 const result=JSON.parse(await service.command(f.context,{action:"create",project:"Fixture",instruction:"完整方案"},f.source));assert.equal(result.status,"running");await service.tick();now+=6000;await service.tick();assert.equal(store.all()[0]!.status,"delivered");assert.equal(notices,1);assert.equal(f.calls.filter(c=>c.tool==="create_thread").length,1);assert.equal(f.calls.some(c=>c.tool==="send_message_to_thread"),false);
});
