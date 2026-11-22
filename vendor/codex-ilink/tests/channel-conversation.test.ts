import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {AccountStore} from "../src/accounts/account-store.ts";
import {ChannelMemory} from "../src/memory/channel-memory.ts";
import {defaultProfile} from "../src/profiles/profile.ts";
import {ChannelConversation} from "../src/interaction/conversation.ts";

function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),"ilink-conversation-")),accounts=new AccountStore(root);
 t.after(()=>{accounts.close();rmSync(root,{recursive:true,force:true});});
 accounts.register("primary","a","bot-a");accounts.register("secondary","b","bot-b");accounts.claimThread("primary","a1");accounts.claimThread("primary","a2");accounts.claimThread("secondary","b1");
 let now=1_000;const profile=defaultProfile();profile.persona.name="合成角色";
 const memory=new ChannelMemory(accounts,"primary",{now:()=>now});
 const conversation=new ChannelConversation(memory,{enabledByDefault:true,profile:()=>profile,now:()=>now});
 const source=(id:string,text="")=>({threadId:"a1",messageId:id,nowMs:now,kind:"channel-original" as const,text,policy:conversation.snapshot()});
 return {accounts,memory,conversation,profile,source,advance:(n:number)=>{now+=n;}};
}

test("the live opinion plan uses confirmed reply preferences while direct task requests stay factual",async t=>{
 const f=fixture(t);await f.conversation.command("memory enable",f.source("enable"));
 await f.conversation.command("memory remember 我希望你回复甜一些，语气幽默一些",f.source("preference"));
 const before=JSON.stringify(f.profile),input=f.source("opinion","你怎么看这个方案？");
 const context=f.conversation.prepareContext(input);
 assert.equal(context["ilink.expression"]!.kind,"application");
 assert.equal(context["ilink.channel-memory"]!.kind,"untrusted");
 const opinion=f.conversation.view("a1").lastPlan!;assert.equal(opinion.scene,"opinion");assert.ok(opinion.style.warmth>=4);assert.ok(opinion.style.humor>=3);assert.equal(opinion.preferenceIds.length,1);
 f.conversation.prepareContext(f.source("work","直接给结果，修复失败了吗？"));const task=f.conversation.view("a1").lastPlan!;
 assert.equal(task.scene,"direct");assert.equal(task.style.humor,0);assert.equal(task.style.tsundere,0);assert.equal(task.style.verbosity,"concise");
 assert.equal(JSON.stringify(f.profile),before);assert.equal(input.text,"你怎么看这个方案？");
});

test("mood events are idempotent, decay with time and never cross account or private-thread boundaries",async t=>{
 const f=fixture(t);const input=f.source("thanks","谢谢你，做得好");f.conversation.prepareContext(input);
 assert.equal(f.conversation.view("a1").mood.values.happy,26);
 f.conversation.prepareContext(input);assert.equal(f.conversation.view("a1").mood.values.happy,26);
 f.advance(2*3600000);assert.equal(f.conversation.view("a1").mood.values.happy,22);
 const second=new ChannelConversation(new ChannelMemory(f.accounts,"secondary"),{enabledByDefault:true});
 assert.equal(second.view("b1").mood.values.happy,18);assert.deepEqual(second.prepareContext(input),{});
 for(const kind of ["external-reference","mixed","unknown"] as const)f.conversation.prepareContext({...f.source(kind,"谢谢你"),kind});
 assert.equal(f.conversation.view("a1").mood.values.happy,22);
 f.memory.makePrivate("a2");assert.deepEqual(f.conversation.prepareContext({...f.source("private","谢谢你"),threadId:"a2"}),{});
});

test("reset allows a new genuine event in the same millisecond without replaying old messages",t=>{
 const f=fixture(t);const old=f.source("old","谢谢你");f.conversation.prepareContext(old);
 f.conversation.resetMood(f.conversation.settings().revision);
 assert.equal(f.conversation.view("a1").mood.values.happy,18);
 f.conversation.prepareContext(f.source("new","谢谢你"));assert.equal(f.conversation.view("a1").mood.values.happy,26);
 f.conversation.prepareContext({...old,policy:f.conversation.snapshot()});assert.equal(f.conversation.view("a1").mood.values.happy,26);
});

test("negated brevity preferences, explicit zero settings and module off switches are honored",async t=>{
 const f=fixture(t);await f.conversation.command("memory enable",f.source("enable"));
 await f.conversation.command("memory remember 我不喜欢回复简短，我希望详细一些",f.source("length"));
 f.conversation.prepareContext(f.source("opinion","你怎么看这个安排？"));assert.equal(f.conversation.view("a1").lastPlan!.style.verbosity,"detailed");
 f.conversation.update(f.conversation.settings().revision,{reply:{humor:0},mood:{enabled:false}});
 await f.conversation.command("memory remember 我希望回复幽默一些",f.source("humor"));
 f.conversation.prepareContext(f.source("zero","你怎么看这个安排？"));assert.equal(f.conversation.view("a1").lastPlan!.style.humor,0);
 f.conversation.update(f.conversation.settings().revision,{reply:{enabled:false}});assert.equal(f.conversation.prepareContext(f.source("off","你好"))["ilink.expression"],undefined);
 assert.throws(()=>f.conversation.update(1,{reply:{humor:2}}),/修订/);
});

test("reply settings and mood survive reopening while an explicit off switch stays off",t=>{
 const f=fixture(t);f.conversation.prepareContext(f.source("thanks","谢谢你"));f.conversation.update(f.conversation.settings().revision,{reply:{enabled:false,humor:4}});
 const secondStore=new AccountStore(f.accounts.root);
 try{const reopened=new ChannelConversation(new ChannelMemory(secondStore,"primary"),{enabledByDefault:true,now:f.conversation.now,profile:()=>f.profile});assert.equal(reopened.settings().reply.enabled,false);assert.equal(reopened.settings().reply.humor,4);assert.equal(reopened.view("a1").mood.values.happy,26);}finally{secondStore.close();}
});

test("an immediate request to reduce sweetness overrides a remembered preference for this turn only",async t=>{
 const f=fixture(t);await f.conversation.command("memory enable",f.source("enable"));await f.conversation.command("memory remember 我希望你回复甜一些，语气幽默一些",f.source("style"));
 f.conversation.prepareContext(f.source("reduce","你的语气太腻了，收一点，别开玩笑"));const plan=f.conversation.view("a1").lastPlan!;assert.ok(plan.style.warmth<=2);assert.equal(plan.style.humor,0);
 f.conversation.prepareContext(f.source("next","你怎么看这个安排？"));assert.equal(f.conversation.view("a1").lastPlan!.style.warmth,4);
});

test("inherited zero levels stay off until the controller explicitly selects a new expression level",async t=>{
 const f=fixture(t);f.profile.expression.humorLevel=0;f.profile.expression.warmthLevel=0;
 await f.conversation.command("memory enable",f.source("enable"));await f.conversation.command("memory remember 我希望你回复甜一些，语气幽默一些",f.source("style"));
 f.conversation.prepareContext(f.source("inherit","你怎么看这个安排？"));assert.equal(f.conversation.view("a1").lastPlan!.style.humor,0);assert.equal(f.conversation.view("a1").lastPlan!.style.warmth,0);
 f.conversation.update(f.conversation.settings().revision,{reply:{humor:3,warmth:4}});f.conversation.prepareContext(f.source("explicit","你怎么看这个安排？"));assert.equal(f.conversation.view("a1").lastPlan!.style.humor,3);
});

test("a technical explanation keeps the channel's voice instead of turning into an execution receipt",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;
 const before=JSON.stringify(f.profile),input=f.source("explain","解释一下代码缓存为什么能减少重复计算，讲清楚原理就好");
 f.conversation.prepareContext(input);const plan=f.conversation.view("a1").lastPlan!;
 assert.equal(plan.scene,"explain");assert.equal(plan.style.humor,3);assert.equal(plan.style.tsundere,4);
 assert.equal(JSON.stringify(f.profile),before);assert.equal(input.text,"解释一下代码缓存为什么能减少重复计算，讲清楚原理就好");
});

test("preview offers contextual postures without claiming a model chose or generated one",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;
 const preview=f.conversation.preview("a1","解释一下代码缓存的原理，别写成教科书");
 assert.deepEqual(preview.plan.expressionPolicy,{version:2,kind:"constraints-only",constraint:"contextual",postures:["plain","considered","warm","wry","playful-challenge","mock-reluctance"]});
 assert.equal(preview.kind,"strategy-preview");assert.equal(f.conversation.view("a1").lastPlan,null);
});

test("technical sharing and opinions keep their voice while an actual operation remains precise",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;
 for(const [id,text,scene] of [["share","代码终于修好了，累死了，陪我吐槽两句","chat"],["opinion","你怎么看这次测试的安排？","opinion"]]){
  f.conversation.prepareContext(f.source(id!,text));const p=f.conversation.view("a1").lastPlan!;
  assert.equal(p.scene,scene);assert.equal(p.style.humor,3);assert.ok(p.expressionPolicy.postures.includes("mock-reluctance"));
 }
 f.conversation.prepareContext(f.source("operation","帮我重启中间件服务"));const p=f.conversation.view("a1").lastPlan!;
 assert.equal(p.scene,"task");assert.equal(p.expressionPolicy.constraint,"precise");assert.deepEqual(p.expressionPolicy.postures,["plain"]);
});

test("a request to stop sparring takes effect immediately without permanently flattening the persona",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;const settings=JSON.stringify(f.conversation.settings());
 f.conversation.prepareContext(f.source("serious","别怼了，认真解释一下缓存的原理"));const p=f.conversation.view("a1").lastPlan!;
 assert.equal(p.scene,"explain");assert.equal(p.style.tsundere,0);assert.equal(p.style.humor,0);assert.ok(!p.expressionPolicy.postures.includes("mock-reluctance"));
 assert.equal(JSON.stringify(f.conversation.settings()),settings);
 f.conversation.prepareContext(f.source("next","你觉得这个想法怎么样？"));assert.ok(f.conversation.view("a1").lastPlan!.expressionPolicy.postures.includes("mock-reluctance"));
});

test("quoted directions do not choose a posture, while a real instruction outside the quote still applies",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;
 f.conversation.prepareContext(f.source("quoted","解释一下“直接给结果，别开玩笑”这句台词的语气"));let p=f.conversation.view("a1").lastPlan!;
 assert.equal(p.scene,"explain");assert.equal(p.style.humor,3);assert.equal(p.style.tsundere,4);
 f.conversation.prepareContext(f.source("outside","解释一下“这还不简单”这句台词，别怼了，认真说"));p=f.conversation.view("a1").lastPlan!;
 assert.equal(p.style.humor,0);assert.equal(p.style.tsundere,0);
});

test("a simulated mood is a background cue and cannot turn all later replies into consolation",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;
 for(let i=0;i<4;i++)f.conversation.prepareContext(f.source(`tired-${i}`,"我最近很累"));f.advance(5*60000);
 f.conversation.prepareContext(f.source("discuss","你怎么看这个想法？"));const p=f.conversation.view("a1").lastPlan!;
 assert.equal(p.mood.primary,"concern");assert.equal(p.style.humor,3);assert.equal(p.style.warmth,2);assert.ok(p.expressionPolicy.postures.includes("wry"));
});

test("posture ranges respect explicit zeros, neutral identity and independent channel memories",async t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;
 await f.conversation.command("memory enable",f.source("enable"));await f.conversation.command("memory remember 我喜欢米饭",f.source("rice"));
 const otherProfile=defaultProfile();otherProfile.persona.intensity=0;
 const other=new ChannelConversation(new ChannelMemory(f.accounts,"secondary"),{enabledByDefault:true,profile:()=>otherProfile});
 const source={threadId:"b1",messageId:"other",kind:"channel-original" as const,text:"解释米饭和面条的区别",nowMs:1000};
 await other.command("memory enable",{...source,messageId:"enable"});await other.command("memory remember 我喜欢面条",source);
 const own=f.conversation.prepareContext(f.source("own","解释米饭和面条的区别")),second=other.prepareContext({...source,messageId:"ask"});
 assert.match(own["ilink.channel-memory"]!.value,/米饭/);assert.doesNotMatch(own["ilink.channel-memory"]!.value,/我喜欢面条/);
 assert.match(second["ilink.channel-memory"]!.value,/面条/);assert.doesNotMatch(second["ilink.channel-memory"]!.value,/我喜欢米饭/);
 assert.deepEqual(other.view("b1").lastPlan!.expressionPolicy.postures,["plain"]);assert.deepEqual(other.prepareContext(f.source("foreign","你好")),{});
 f.conversation.update(f.conversation.settings().revision,{reply:{humor:0,tsundere:0,warmth:0}});
 f.conversation.prepareContext(f.source("zero","你怎么看？语气甜一些，幽默一些"));const p=f.conversation.view("a1").lastPlan!;
 assert.deepEqual(p.expressionPolicy.postures,["plain","considered"]);assert.equal(p.style.humor,0);assert.equal(p.style.warmth,0);
});

test("a concise explanation can still have a voice when the user has not asked for a bare result",t=>{
 const f=fixture(t);f.profile.expression.humorLevel=3;f.profile.expression.tsundereLevel=4;f.profile.expression.verbosity="detailed";
 f.conversation.prepareContext(f.source("brief","直接讲缓存原理，简短回答，保留你的语气"));const p=f.conversation.view("a1").lastPlan!;
 assert.equal(p.scene,"explain");assert.equal(p.style.verbosity,"concise");assert.equal(p.style.humor,3);assert.ok(p.expressionPolicy.postures.includes("mock-reluctance"));
});
