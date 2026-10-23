import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {AccountStore} from '../vendor/codex-ilink/src/accounts/account-store.ts';
import {accountCodex,AccountLeaseStore} from '../vendor/codex-ilink/src/accounts/account-scope.ts';
import {CodexRuntime} from '../vendor/codex-ilink/src/codex/codex-runtime.ts';
import {BridgeEngine} from '../vendor/codex-ilink/src/bridge/bridge.ts';
import {DelegationStore,DelegationService} from '../vendor/codex-ilink/src/delegation/delegation-service.ts';
import {OfficialDesktopTools} from '../vendor/codex-ilink/src/delegation/desktop-tools.ts';
import {desktopCodexAppServerCommand} from '../vendor/codex-ilink/src/windows/host.ts';
import {AppServerConnection} from '../vendor/codex-ilink/src/codex/app-server-connection.ts';
import {startDelegationServer} from '../vendor/codex-ilink/src/delegation/ipc.ts';

const target=process.argv[process.argv.indexOf('--target')+1];
assert(process.argv.includes('--target')&&/^[0-9a-f-]{36}$/i.test(target??''),'Explicit isolated --target required');
const root=dirname(dirname(fileURLToPath(import.meta.url))), id=randomUUID(), directory=join(root,'.local','wechat-delegation-acceptance',id);
mkdirSync(directory,{recursive:true});
const accounts=new AccountStore(directory),state=accounts.openState('primary'),database=join(directory,'state.sqlite');
const environment={...process.env,CODEX_ILINK_LEASE_DB:database,USERNAME:`ilink-acceptance-${id}`};
delete environment.CODEX_APP_TOOLS_PIPE_PATH;
const instance=`acceptance-${id}`;
let delegationHandler;
const delegationPipe=`\\\\.\\pipe\\ilink-delegation-acceptance-${id}`;
const ipc=await startDelegationServer(delegationPipe,(context,args)=>{assert(delegationHandler,'Handler unavailable');return delegationHandler(context,args);});
const runtime=await CodexRuntime.create({bridgeInstanceId:instance,command:desktopCodexAppServerCommand(environment),environment,delegationPipe});
const reader=await CodexRuntime.create({bridgeInstanceId:instance,command:desktopCodexAppServerCommand(environment),environment});
const leases=new AccountLeaseStore(database,accounts,'primary');
let bridge;let unsubscribe;const eventTasks=new Set();const sent=[];
let service;
let reopenedDatabase;
try{
 const page=await reader.readRecentTurns(target);const initial=await reader.readThread({threadId:target,includeTurns:false});
 // Fixture marker may be older than the last 10 turns; use its pinned preparation history window.
 let prepared=JSON.stringify(page).includes('DESKTOP_TARGET_READY'),cursor=page.nextCursor;
 for(let n=0;!prepared&&typeof cursor==='string'&&n<10;n++){const p=await reader.readRecentTurns(target,cursor);prepared=JSON.stringify(p).includes('DESKTOP_TARGET_READY');cursor=p.nextCursor;}
 assert(prepared,'Target must be a prepared acceptance fixture');
 let origin;
 if(process.argv.includes('--legacy-origin')){
   const legacy=await AppServerConnection.create({bridgeInstanceId:instance,command:desktopCodexAppServerCommand(environment),environment});
   try{
     origin=await legacy.request('thread/start',{cwd:directory,approvalPolicy:'never',sandbox:'danger-full-access',dynamicTools:[]});
     accounts.claimThread('primary',origin.thread.id);
     const lease={threadId:origin.thread.id,owner:'bridge',instanceId:instance,operationId:randomUUID(),turnId:null,createdAtMs:Date.now()};
     assert(leases.tryAcquire(lease).acquired);
     let done;const finished=new Promise(r=>done=r);const timeout=setTimeout(()=>done(null),60000);
     const off=legacy.onEvent(e=>{if(e.method==='turn/completed')done(e.params.turn);});
     try{await legacy.request('turn/start',{threadId:origin.thread.id,clientUserMessageId:randomUUID(),input:[{type:'text',text_elements:[],text:'隔离旧会话准备：只回复 LEGACY_READY，不调用工具。'}]});assert.equal((await finished)?.status,'completed');}finally{clearTimeout(timeout);off();const held=leases.getLease(origin.thread.id);if(held?.instanceId===instance)leases.release(held);}
   }finally{legacy.close();}
   await new Promise(r=>setTimeout(r,300));await runtime.resumeThread(origin.thread.id);
 }else{origin=await runtime.startThread(directory,{approvalPolicy:'never',sandbox:'danger-full-access'});}
 accounts.claimThread('primary',origin.thread.id);state.setMainThreadId(origin.thread.id);
 const session={botId:'acceptance-bot',controllerUserId:'acceptance-controller',botToken:'fixture',baseUrl:'https://example.invalid'};
 state.bindController({accountId:session.botId,userId:session.controllerUserId,boundAtMs:Date.now()});
 const store=new DelegationStore(accounts.database);
 const options={account:'primary',store,root:directory,owner:x=>accounts.owner(x),explicitOwner:x=>accounts.explicitOwner(x),resolve:async s=>{if(s===target)return [{id:target,title:'隔离 Desktop 验收'}];let cursor;const matches=[];do{const p=await reader.findDelegationThreads(s,cursor);matches.push(...p.data.map(t=>({id:t.id,title:t.name??t.preview})));cursor=p.nextCursor;}while(cursor);const exact=matches.filter(t=>t.title?.toLocaleLowerCase()===s.toLocaleLowerCase());return exact.length?exact:matches;},tools:()=>new OfficialDesktopTools(environment),readResult:async(t,turn)=>{const p=await reader.readRecentTurns(t);const result=p.data.find(x=>x.id===turn);assert(result,'Target turn missing');return result.items.filter(x=>x.type==='agentMessage'&&x.phase==='final_answer').map(x=>x.text).join('\n');},notify:async(job,text,key)=>bridge.notifyDelegation(text,key,job.contextToken)};
 service=new DelegationService(options);
 const scoped=accountCodex(runtime,accounts,'primary',undefined,{service,state,register:handler=>{delegationHandler=handler;}});
 bridge=new BridgeEngine({codex:scoped,state,leases,bridgeInstanceId:instance,mainThreadId:origin.thread.id,inboxDirectory:directory,newId:randomUUID,now:Date.now,session,ilink:{sendText:async message=>{sent.push(message);return {ret:0};}}});
 unsubscribe=scoped.onEvent(e=>{const p=bridge.ingestCodexEvent(e).catch(error=>{throw error;});eventTasks.add(p);void p.finally(()=>eventTasks.delete(p));});
 const file=`wechat-delegation-${id}.txt`;
 const selector=process.argv.includes('--target-name')?initial.thread.name:target;assert(selector,'Target name unavailable');
 const request=`告诉会话 ${selector}，在你自己的工作目录 outputs/${file} 新建 UTF-8 文本，内容 WECHAT_DELEGATION_FILE_OK_${id}，再读取确认，只操作这个新的验收文件。执行结束后把结果返回给我。`;
 await bridge.ingestBatch({cursor:'acceptance-cursor',messages:[{message_id:1,from_user_id:session.controllerUserId,to_user_id:session.botId,context_token:'acceptance-context',message_type:1,message_state:2,item_list:[{type:1,text_item:{text:request}}]}]});
 let recovered=false;
 const deadline=Date.now()+150000;
 while(Date.now()<deadline){
   await service.tick();
   const jobs=store.all();
   if(!jobs.length&&sent.length&&state.listUnresolvedDispatchIntents().length===0)throw Error('Origin finished without registering delegation: '+sent.map(m=>m.text).join('\n'));
   if(!recovered&&jobs.some(j=>j.status==='running')){reopenedDatabase=new DatabaseSync(database);const recoveredStore=new DelegationStore(reopenedDatabase);recoveredStore.recover();service=new DelegationService({...options,store:recoveredStore});recovered=true;}
   if(jobs.some(j=>j.status==='delivered'))break;
   await new Promise(r=>setTimeout(r,1000));
 }
 await Promise.allSettled([...eventTasks]);
 const jobs=store.all();assert.equal(jobs.length,1);const job=jobs[0];assert.equal(job.status,'delivered');
 assert.equal(readFileSync(join(initial.thread.cwd,'outputs',file),'utf8').replace(/^\uFEFF/,'').trim(),`WECHAT_DELEGATION_FILE_OK_${id}`);
 const notifications=sent.filter(m=>m.clientId.startsWith(`delegation:${job.id}:result:`));
 assert(notifications.length&&notifications.every(m=>m.session.controllerUserId===session.controllerUserId));
 assert(notifications.some(m=>m.text.includes(`[iLink委派:${job.id}]`)));
 const report={passed:true,jobId:job.id,targetTurn:job.targetTurn,persisted:true,workerRecreated:recovered,databaseReopened:Boolean(reopenedDatabase),fileVerified:true,endpointInherited:false,legacyOrigin:process.argv.includes('--legacy-origin'),targetByName:process.argv.includes('--target-name'),realDesktopExecution:true,wechatTransport:'isolated recorded sender, not actual WeChat',parts:notifications.length};
 writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{unsubscribe?.();bridge?.close();runtime.close();reader.close();await new Promise(r=>ipc.close(r));reopenedDatabase?.close();leases.close();state.close();accounts.close();}
