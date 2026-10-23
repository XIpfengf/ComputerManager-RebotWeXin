import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import test from "node:test";
import {CodexRuntime} from "../src/codex/codex-runtime.ts";
import {BridgeDaemon} from "../src/daemon/bridge-daemon.ts";
import {SqliteState} from "../src/bridge/sqlite-state.ts";
import {SqliteTurnLeaseStore} from "../src/coordination/turn-lease.ts";

test("a corrupt background Stop query cannot interrupt an unrelated live WeChat turn",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ilink-background-fault-"));
  const state=new SqliteState(join(root,"state.sqlite"));
  const leases=new SqliteTurnLeaseStore(join(root,"state.sqlite"));
  const options={bridgeInstanceId:"fault-domain-test",command:[process.execPath,resolve("tests/fixtures/fake-broken-history.mjs"),"--break-pages"] as [string,...string[]]};
  const execution=await CodexRuntime.create(options);
  const observer=await CodexRuntime.create(options);
  const errors:unknown[]=[];
  execution.onEvent(e=>{if(e.method==="error")errors.push(e);});
  state.setMainThreadId("current");
  state.bindController({accountId:"bot",boundAtMs:1,userId:"user"});
  state.putTerminalNotificationJob({threadId:"large",turnId:"target",evidence:"unmatched",capturedAtMs:100,cwd:root});
  const daemon=new BridgeDaemon({bridgeInstanceId:"fault-domain-test",state,leases,now:()=>200,newId:()=>"unused",inboxDirectory:root,
    codex:{readThread:execution.readThread.bind(execution),onEvent:execution.onEvent.bind(execution),close:()=>execution.close(),async resumeThread(id){return {thread:{id}};},async startThread(){assert.fail("existing main");},async startTurn(){assert.fail("must not replay task");},async setThreadName(){return {};}},
    terminalReader:observer,
    hookReceiver:{async start(){},async close(){},async drainSpool(){return 0;}},
    session:{baseUrl:"https://test.example",botId:"bot",botToken:"test",controllerUserId:"user"},
    ilink:{async getUpdates(){return {kind:"timeout",cursor:""};},async sendText(i){return {accepted:true,clientId:i.clientId};}},
  });
  try {
    await execution.startTurn({threadId:"current",text:"只查询状态",clientUserMessageId:"message"});
    await daemon.start();
    assert.deepEqual(errors,[],"background history must not close the live execution connection");
    assert.deepEqual((await execution.listModels()).data,[]);
    assert.equal(state.listTerminalNotificationJobs(200).length,1,"failed query remains pending, not reported as completed");
  }finally{await daemon.stop();observer.close();execution.close();leases.close();state.close();rmSync(root,{recursive:true,force:true});}
});
