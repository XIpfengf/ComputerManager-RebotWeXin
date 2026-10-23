import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accountCodex } from "../src/accounts/account-scope.ts";
import type { AccountStore } from "../src/accounts/account-store.ts";
import type { CodexRuntime } from "../src/codex/codex-runtime.ts";
import type { AppServerEventListener } from "../src/codex/protocol.ts";
import type { ChannelProfileService } from "../src/profiles/channel-profile.ts";
import { recentHistory } from "../src/accounts/recent-history.ts";

test("history windows paginate across a record boundary without exposing tools or partial records", async t => {
  const root=mkdtempSync(join(tmpdir(),"ilink-history-pages-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,"rollout.jsonl");
  const message=(text:string)=>JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text}]}})+"\n";
  writeFileSync(path,message("old-marker")+message("boundary-marker"+"界".repeat(2000))+JSON.stringify({type:"response_item",payload:{type:"custom_tool_call_output",output:"secret"+"x".repeat(4*1024*1024-3000)}})+"\n"+message("new-marker")+'{"type":"response_item","payload":');
  const first=await recentHistory(path,"");
  assert.match(JSON.stringify(first.messages),/new-marker/);
  assert.doesNotMatch(JSON.stringify(first.messages),/secret|boundary-marker/);
  assert.ok(first.window.nextBeforeBytes!==null);
  const second=await recentHistory(path,"boundary-marker",first.window.nextBeforeBytes!);
  assert.match(JSON.stringify(second.messages),/boundary-marker/);
  assert.equal(second.window.nextBeforeBytes,null);
  assert.ok(first.window.bytesRead<=4*1024*1024);
  await assert.rejects(recentHistory("relative-path",""),/PATH_UNAVAILABLE/);
});

test("history tool reads bounded text from a rollout without requesting full turns or resuming it", async t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-history-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, JSON.stringify({type:"response_item",payload:{type:"custom_tool_call_output",output:"x".repeat(9_000_000)}})+"\n"+
    JSON.stringify({timestamp:"2026-10-18T05:00:00Z",type:"event_msg",payload:{type:"task_started",turn_id:"turn-1"}})+"\n"+
    JSON.stringify({timestamp:"2026-10-18T05:01:00Z",type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"八批次治理：48/54，备份仍需验证。"}]}})+"\n");
  let emit: AppServerEventListener = () => {};
  let settle!: (result: Record<string, unknown>) => void;
  const response = new Promise<Record<string, unknown>>(resolve => {settle=resolve;});
  const runtime = {
    onEvent(listener: AppServerEventListener) { emit=listener; return () => {}; },
    async readThread(input: {includeTurns:boolean}) {
      assert.equal(input.includeTurns, false, "full history reads corrupt the shared App Server protocol on large sessions");
      return {thread:{id:"target",path,status:{type:"notLoaded"},name:"八批次治理"}};
    },
    respondToServerRequest(_id: unknown, result: Record<string, unknown>) {settle(result);return true;},
    isServerRequestLive() {return true;},
  } as unknown as CodexRuntime;
  const accounts = {owner: () => "primary"} as unknown as AccountStore;
  accountCodex(runtime,accounts,"primary",{} as ChannelProfileService).onEvent(()=>{});
  emit({id:1,method:"item/tool/call",params:{threadId:"current",tool:"channel_history",arguments:{threadId:"target"}}});
  const result=await response;
  assert.equal(result.success,true);
  const text=JSON.stringify(result.contentItems);
  assert.match(text,/48\/54/);
  assert.match(text,/notLoaded/);
  assert.match(text,/task_started/);
  assert.ok(text.length<35000);
});
