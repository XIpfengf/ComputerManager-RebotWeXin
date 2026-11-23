import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {resolve} from "node:path";

test("MCP exposes a refreshable creation tool independent of a frozen legacy dynamic schema",async t=>{
 const child=spawn(process.execPath,["--disable-warning=ExperimentalWarning","--experimental-strip-types",resolve('src/delegation/mcp-server.ts')],{env:{...process.env,CODEX_ILINK_DELEGATION_PIPE:"unused-test-pipe"},windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();t.after(()=>{child.stdin.end();child.kill();});
 const pending=new Map<number,(v:any)=>void>();let id=0;createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);pending.get(m.id)?.(m.result);pending.delete(m.id);});
 const request=(method:string)=>new Promise<any>((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>reject(Error('metadata timeout')),5000);pending.set(next,v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params:{}})+'\n');});
 await request('initialize');const inventory=await request('tools/list');const modern=inventory.tools.find((x:any)=>x.name==='ilink_delegate_task');assert.ok(modern,'modern MCP alias must not be hidden behind old delegate_task');assert.ok(modern.inputSchema.properties.action.enum.includes('create'));assert.ok(modern.inputSchema.properties.action.enum.includes('retry'));assert.ok(modern.inputSchema.properties.action.enum.includes('activity'));
 assert.ok(modern.inputSchema.properties.action.enum.includes('sessions'));
});
