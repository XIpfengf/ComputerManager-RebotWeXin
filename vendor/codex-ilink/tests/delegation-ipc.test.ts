import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startDelegationServer,callDelegationServer} from "../src/delegation/ipc.ts";
test("delegation IPC validates origin and returns only the authorized handler response",async()=>{
 const path=process.platform==="win32"?`\\\\.\\pipe\\ilink-delegation-test-${randomUUID()}`:join(tmpdir(),`ilink-${randomUUID()}.sock`);let count=0;
 const server=await startDelegationServer(path,async(_context,args)=>{count++;return JSON.stringify(args);});
 try{const bad=await callDelegationServer(path,{threadId:"bad",turnId:"bad"},{action:"submit"});assert.equal(bad.ok,false);assert.equal(count,0);const good=await callDelegationServer(path,{threadId:randomUUID(),turnId:randomUUID()},{action:"status"});assert.equal(good.ok,true);assert.equal(count,1);assert.equal(good.text,'{"action":"status"}');}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
