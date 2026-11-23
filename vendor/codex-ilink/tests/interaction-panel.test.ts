import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,mkdirSync,renameSync,rmdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {AccountStore} from "../src/accounts/account-store.ts";
import {ChannelMemory} from "../src/memory/channel-memory.ts";
import {ChannelConversation} from "../src/interaction/conversation.ts";
import {startInteractionPanel,panelChannel} from "../src/interaction/panel.ts";

test("the local panel scopes every request to its token and rejects stale, foreign-origin and forged settings",async t=>{
 const root=mkdtempSync(join(tmpdir(),"ilink-panel-")),accounts=new AccountStore(root);
 accounts.register("primary","a","ba");accounts.register("secondary","b","bb");accounts.claimThread("primary","a1");accounts.claimThread("secondary","b1");
 const a=new ChannelConversation(new ChannelMemory(accounts,"primary"),{enabledByDefault:true}),b=new ChannelConversation(new ChannelMemory(accounts,"secondary"),{enabledByDefault:true});
 const panel=await startInteractionPanel({channels:new Map([["primary",panelChannel(a,()=>"a1")],["secondary",panelChannel(b,()=>"b1")]]),accessFile:join(root,"panel.json")});
 t.after(async()=>{await panel.close();accounts.close();rmSync(root,{recursive:true,force:true});});
 const token=new URLSearchParams(new URL(panel.urlFor("primary")!).hash.slice(1)).get("token")!;
 const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
 assert.equal((await fetch(panel.origin+"/api/status")).status,401);
 const view=await (await fetch(panel.origin+"/api/status",{headers})).json() as any;assert.equal(view.account,"primary");assert.equal(view.expressionVersion,2);
 const update=(body:unknown,extra={})=>fetch(panel.origin+"/api/settings",{method:"POST",headers:{...headers,...extra},body:JSON.stringify(body)});
 assert.equal((await update({revision:view.settings.revision,patch:{reply:{humor:5}}})).status,200);
 assert.equal(a.settings().reply.humor,5);assert.equal(b.settings().reply.humor,null);
 assert.equal((await update({revision:1,patch:{reply:{humor:0}}})).status,409);
 assert.equal((await update({revision:2,patch:{reply:{humor:0}},account:"secondary"})).status,400);
 assert.equal((await update({revision:2,patch:{reply:{humor:0}}},{Origin:"https://untrusted.invalid"})).status,403);
 assert.equal((await update({revision:2,patch:{persona:{name:"forged"}}})).status,400);
 const preview=await fetch(panel.origin+"/api/preview",{method:"POST",headers,body:JSON.stringify({text:"解释代码缓存的原理"})});assert.equal(preview.status,200);const result=await preview.json() as any;assert.equal(result.kind,"strategy-preview");assert.equal(result.plan.scene,"explain");assert.equal(result.plan.expressionPolicy.kind,"constraints-only");assert.equal(result.plan.delivery,undefined);
 assert.match(readFileSync(join(root,"panel.json"),"utf8"),/primary/);
 const html=await (await fetch(panel.origin)).text();assert.match(html,/记忆与表达/);assert.doesNotMatch(html,/https:\/\/.*(?:script|fonts)/);
});

test("an unavailable panel access file does not invalidate existing channel links", async t => {
 const root = mkdtempSync(join(tmpdir(), "ilink-panel-unavailable-"));
 const accessFile = join(root, "access.json");
 const channel = { snapshot: () => ({ ready: true }), preview() {}, update() {}, reset() {}, weights() {} };
 const channels = new Map([["primary", channel]]);
 const panel = await startInteractionPanel({ channels, accessFile });
 t.after(async () => { await panel.close(); rmSync(root, { recursive: true, force: true }); });
 const primary = panel.urlFor("primary")!;
 renameSync(accessFile, accessFile + ".saved");
 mkdirSync(accessFile);
 channels.set("secondary", channel);
 assert.equal(panel.urlFor("secondary"), undefined);
 assert.equal(panel.urlFor("primary"), primary);
 const token = new URLSearchParams(new URL(primary).hash.slice(1)).get("token");
 assert.equal((await fetch(panel.origin + "/api/status", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
 rmdirSync(accessFile);
 const secondary = panel.urlFor("secondary");
 assert.ok(secondary);
 assert.equal(JSON.parse(readFileSync(accessFile, "utf8")).accounts.secondary, secondary);
});

test("failure to publish panel access releases the listener before returning", () => {
 const root = mkdtempSync(join(tmpdir(), "ilink-panel-start-failure-"));
 try {
  const script = `import {startInteractionPanel} from ${JSON.stringify(new URL("../src/interaction/panel.ts", import.meta.url).href)};
    try {
      await startInteractionPanel({channels:new Map(),accessFile:process.argv[1]});
      process.exitCode = 2;
    } catch { console.log("access unavailable"); }`;
  const child = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", script, root,
  ], { encoding: "utf8", timeout: 3000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0);
  assert.match(child.stdout, /access unavailable/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
