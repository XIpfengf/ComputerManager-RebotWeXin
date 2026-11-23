import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {AccountStore} from "../src/accounts/account-store.ts";
import {ChannelMemory} from "../src/memory/channel-memory.ts";

function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),"ilink-recall-")),accounts=new AccountStore(root);
 t.after(()=>{accounts.close();rmSync(root,{recursive:true,force:true});});
 accounts.register("primary","a","bot-a");accounts.register("secondary","b","bot-b");
 accounts.claimThread("primary","a1");accounts.claimThread("primary","a2");accounts.claimThread("secondary","b1");
 let now=1_000;const memory=new ChannelMemory(accounts,"primary",{now:()=>now});
 const source=(id:string)=>({threadId:"a1",messageId:id,nowMs:now++,kind:"channel-original" as const});
 return {accounts,memory,source};
}

test("an opinion question recalls the explicit sweet and humorous reply preference with source receipts",async t=>{
 const {memory,source}=fixture(t);await memory.command("memory enable",source("enable"));
 await memory.command("memory remember 我希望你回复甜一些，语气幽默一些",source("style"));
 await memory.command("memory remember 我喜欢吃米饭",source("food"));
 const context=memory.context("a2","你怎么看这个安排？");
 assert.match(JSON.stringify(context),/幽默/);assert.doesNotMatch(JSON.stringify(context),/米饭/);
 const receipt=JSON.parse(await memory.command("memory explain",{...source("explain"),threadId:"a2"}));
 assert.equal(receipt.selected.length,1);assert.equal(receipt.selected[0].messageId,"style");
 assert.equal(receipt.selected[0].threadId,"a1");assert.ok(receipt.selected[0].reasons.length>0);
});

test("current recall follows corrections, historical recall labels old evidence, and forgetting clears receipts",async t=>{
 const {memory,source}=fixture(t);await memory.command("memory enable",source("enable"));
 await memory.command("memory remember 我喜欢吃鸡蛋",source("old"));const old=JSON.parse(await memory.command("memory show",source("show"))).memories[0];
 await memory.command(`memory correct ${old.id} ${old.revision} 我不喜欢吃鸡蛋`,source("correct"));
 assert.doesNotMatch(JSON.stringify(memory.context("a2","晚膳吃什么")),/"content":"我喜欢吃鸡蛋"/);
 const historical=memory.recall("a2","最早我对鸡蛋是什么偏好？");assert.equal(historical.selected[0]!.memory.messageId,"old");assert.equal(historical.selected[0]!.memory.status,"superseded");
 const current=JSON.parse(await memory.command("memory show",source("show2"))).memories[0];
 memory.context("a2","晚餐吃什么");await memory.command(`memory forget ${current.id} ${current.revision}`,source("forget"));
 assert.equal(memory.explain("a2").selected.length,0);assert.doesNotMatch(JSON.stringify(memory.context("a2","最早的鸡蛋偏好")),/鸡蛋/);
});

test("maximum recall weights never import other accounts, external evidence or unrelated text",async t=>{
 const {memory,source,accounts}=fixture(t);await memory.command("memory enable",source("enable"));
 const b=new ChannelMemory(accounts,"secondary");const other={...source("other"),threadId:"b1"};await b.command("memory enable",other);await b.command("memory remember 我喜欢吃合成秘密菜",other);
 await memory.command("memory remember 我喜欢吃外部菜",{...source("external"),kind:"external-reference"});
 await memory.command("memory remember 我喜欢吃米饭",source("own"));
 for(const key of ["relevance","time","explicit"])await memory.command(`memory recall set ${key} 5`,source(key));
 assert.deepEqual(memory.context("a2","解释数据库事务"),{});
 assert.doesNotMatch(JSON.stringify(memory.context("a2","我有什么饮食偏好")),/秘密|外部/);
 assert.deepEqual(memory.context("b1","饮食偏好"),{});
 assert.match(await memory.command("memory recall set time 5",{...source("bad"),kind:"unknown"}),/未修改/);
});
