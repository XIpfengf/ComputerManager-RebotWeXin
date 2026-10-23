import {randomUUID} from "node:crypto";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {DatabaseSync} from "node:sqlite";
import type {DelegationContext,DesktopTools} from "./desktop-tools.ts";
export function initializeDelegationPermissions(root:string,accounts:readonly string[]):void {
 const path=join(root,"delegation-permissions.json");if(existsSync(path))return;
 try{writeFileSync(path,JSON.stringify({version:1,accounts:Object.fromEntries(accounts.map(name=>[name,{allowDesktopThreads:[]}]))},null,2),{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
}

export type DelegationJob=DelegationContext & {id:string;account:string;target:string;title:string;instruction:string;userText?:string;contextToken:string;status:"queued"|"sending"|"running"|"unknown"|"completed"|"delivered"|"cancelled";createdAt:number;targetTurn?:string;historyCursor?:string;result?:string;issue?:string};
export class DelegationStore {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS delegation_jobs(id TEXT PRIMARY KEY,account TEXT NOT NULL,origin_turn TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(account,origin_turn,target)) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS delegation_active_target ON delegation_jobs(target) WHERE status IN ('sending','running','unknown');`);}
  recover():void{for(const j of this.all())if(j.status==="sending"){j.status="unknown";j.issue="发送回执未确认，正在只读核对；不会自动重发。";this.save(j);}}
  claimSending(j:DelegationJob):boolean{try{return Number(this.db.prepare("UPDATE delegation_jobs SET status='sending',body=? WHERE id=? AND status='queued'").run(JSON.stringify({...j,status:"sending"}),j.id).changes)===1;}catch{return false;}}
  all(account?:string):DelegationJob[]{return (account?this.db.prepare("SELECT body FROM delegation_jobs WHERE account=? ORDER BY rowid").all(account):this.db.prepare("SELECT body FROM delegation_jobs ORDER BY rowid").all()).map(r=>JSON.parse(r.body as string));}
  save(j:DelegationJob):void{this.db.prepare("INSERT INTO delegation_jobs(id,account,origin_turn,target,status,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body").run(j.id,j.account,j.turnId,j.target,j.status,JSON.stringify(j));}
}
export type DelegationOptions={account:string;store:DelegationStore;root:string;owner:(id:string)=>string;explicitOwner:(id:string)=>string|undefined;resolve:(selector:string)=>Promise<Array<{id:string;title:string}>>;readResult?:(target:string,turn:string)=>Promise<string>;tools:()=>DesktopTools;notify:(job:DelegationJob,text:string,key:string)=>Promise<boolean>;now?:()=>number};
// Desktop unloads inactive threads. Loading is not execution: require no live
// or unrecognised turn state as well as a non-busy thread state before sending.
function canReceiveDelegation(snapshot:Record<string,any>):boolean {
 const state=snapshot.thread?.status?.type;
 return (state==="idle"||state==="notLoaded")&&Array.isArray(snapshot.turns)&&snapshot.turns.every((turn:any)=>["completed","failed","interrupted"].includes(turn?.status));
}
export class DelegationService {
  readonly options:DelegationOptions;
  #busy=false;
  #next=0;
  #offset=0;
  constructor(options:DelegationOptions){this.options=options;}
  allowed(id:string):boolean{
    const o=this.options;if(o.owner(id)===o.account)return true;
    if(o.explicitOwner(id)!==undefined)return false;
    const file=join(o.root,"delegation-permissions.json");
    try{if(!existsSync(file))return false;const p=JSON.parse(readFileSync(file,"utf8"));return p.version===1&&Array.isArray(p.accounts?.[o.account]?.allowDesktopThreads)&&p.accounts[o.account].allowDesktopThreads.includes(id);}catch{return false;}
  }
  async command(context:DelegationContext,args:unknown,source:{text:string;contextToken:string;isLive?:()=>boolean}):Promise<string>{
    if(!args||typeof args!=="object"||Array.isArray(args))throw Error("参数无效");
    const p=args as Record<string,unknown>;
    if(Object.keys(p).some(k=>!["action","target","instruction","jobId"].includes(k)))throw Error("未知参数");
    const o=this.options;
    if(p.action==="list"||p.action==="status"||p.action==="cancel"){
      const jobs=o.store.all(o.account).filter(j=>!p.jobId||j.id===p.jobId);
      if(p.action==="cancel"){
        if(typeof p.jobId!=="string"||jobs.length!==1||jobs[0]!.status!=="queued")throw Error("只能取消本通道尚未投递的委派；不会停止目标会话。");
        if(!/(取消|cancel)/iu.test(source.text)||!source.text.includes(p.jobId))throw Error("取消须由用户本轮明确指定委派编号。");
        jobs[0]!.status="cancelled";o.store.save(jobs[0]!);
      }
      return JSON.stringify(jobs.slice(-20).map(j=>({id:j.id,target:j.title,status:j.status,issue:j.issue,targetTurn:j.targetTurn})));
    }
    if(p.action!=="submit"||typeof p.target!=="string"||!p.target.trim()||p.target.length>200||typeof p.instruction!=="string"||!p.instruction.trim()||p.instruction.length>16000)throw Error("需要目标会话和明确任务，任务不得超过16000字符。");
    if(!/(告诉|转告|沟通|委派|通知|交给|让|delegate)/iu.test(source.text)||!source.text.includes(p.target))throw Error("未找到用户本轮对该目标的明确委派授权，请用户说明目标会话和任务。");
    if(/^[0-9a-f-]{36}$/iu.test(p.target)&&!this.allowed(p.target))throw Error("没有找到唯一的授权目标；不读取或投递其他通道会话。");
    const candidates=(await o.resolve(p.target)).filter(t=>this.allowed(t.id));
    if(candidates.length!==1)throw Error(candidates.length?"存在多个授权目标，请用户提供准确名称或会话ID。":"没有找到唯一的授权目标；不读取或投递其他通道会话。");
    const target=candidates[0]!;
    if(target.id===context.threadId)throw Error("不能委派给当前会话自身。");
    const previous=o.store.all(o.account).find(j=>j.turnId===context.turnId&&j.target===target.id);
    if(previous){if(previous.instruction!==p.instruction)throw Error("本轮已登记该目标的另一任务，请另发一条消息。");return JSON.stringify({id:previous.id,status:previous.status,reused:true});}
    if(source.isLive?.()===false)throw Error("委派请求已失效，未登记新任务。");
    const job:DelegationJob={...context,id:randomUUID(),account:o.account,target:target.id,title:target.title,instruction:p.instruction,userText:source.text,contextToken:source.contextToken,status:"queued",createdAt:(o.now??Date.now)()};
    o.store.save(job);return JSON.stringify({id:job.id,status:job.status,target:job.title,note:"已持久化排队，尚不代表目标已接收。目标忙碌时不打断；结果核对后回到本微信通道。"});
  }
  async tick():Promise<void>{
    const o=this.options;const now=(o.now??Date.now)();if(this.#busy||now<this.#next)return;this.#busy=true;this.#next=now+5000;
    try{const pending=o.store.all(o.account).filter(j=>!["delivered","cancelled"].includes(j.status));const batch=pending.length?[...pending.slice(this.#offset%pending.length),...pending.slice(0,this.#offset%pending.length)].slice(0,4):[];this.#offset=pending.length?(this.#offset+batch.length)%pending.length:0;for(const job of batch){
      if(!this.allowed(job.target)){job.issue="目标授权已撤销，暂停投递和读取。";o.store.save(job);await o.notify(job,`委派暂停\n编号：${job.id}\n${job.issue}`,`delegation:${job.id}:revoked`).catch(()=>false);continue;}
      if(job.status==="completed") {if(await o.notify(job,`委派结果 · ${job.title}\n编号：${job.id}\n来源会话：${job.threadId}\n目标回合：${job.targetTurn??"未确认"}\n\n${job.result??""}`,`delegation:${job.id}:result`)){job.status="delivered";o.store.save(job);}continue;}
      const tools=o.tools();
      try{
        const before=await tools.call(job,"read_thread",{threadId:job.target,hostId:"local",turnLimit:10,includeOutputs:job.status!=="queued"&&!job.targetTurn,maxOutputCharsPerItem:20000,...(job.historyCursor?{cursor:job.historyCursor}:{})});
        const marker=`[iLink委派:${job.id}]`;
        if(!job.targetTurn&&job.status!=="queued"){const bound=before.turns?.find((t:any)=>JSON.stringify(t.items).includes(marker));if(bound){job.targetTurn=bound.id;o.store.save(job);}}
        const failed=before.turns?.find((t:any)=>t.id===job.targetTurn&&["failed","interrupted"].includes(t.status));
        if(failed){job.result=`目标委派回合${failed.status==="failed"?"执行失败":"已中断"}，未取得成功结果。未自动重试，也未停止其他任务。`;job.status="completed";o.store.save(job);continue;}
        // Only an exact correlation marker in an actual completed turn can finish a job.
        const found=before.turns?.find((t:any)=>t.status==="completed"&&(t.id===job.targetTurn||t.items?.some((i:any)=>i.type==="agentMessage"&&i.phase==="final_answer"&&i.text?.includes(marker))));
        if(found&&(job.status==="running"||job.status==="unknown")){
          const text:string=o.readResult?await o.readResult(job.target,found.id):found.items.filter((i:any)=>i.type==="agentMessage"&&i.phase==="final_answer").map((i:any)=>i.text).join("\n");if(!text.includes(marker)&&found.id!==job.targetTurn)throw Error("E_DELEGATION_RESULT_MISMATCH");job.targetTurn=found.id;job.result=text||"目标回合已结束，但没有最终文字结果，不能据此声称操作成功。";job.status="completed";delete job.issue;delete job.historyCursor;o.store.save(job);continue;
        }
        if(job.status!=="queued"){if(typeof before.page?.nextCursor==="string")job.historyCursor=before.page.nextCursor;else delete job.historyCursor;o.store.save(job);continue;}
        if(!canReceiveDelegation(before)){job.issue="目标忙碌或状态未明确，继续排队，不打断。";o.store.save(job);await o.notify(job,`委派仍在排队 · ${job.title}\n编号：${job.id}\n${job.issue}`,`delegation:${job.id}:busy`).catch(()=>false);continue;}
        if(o.store.all().find(j=>j.target===job.target&&["queued","sending","running","unknown"].includes(j.status))?.id!==job.id)continue;
        // Check again immediately before a single non-retried send.
        const check=await tools.call(job,"read_thread",{threadId:job.target,hostId:"local",turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});
        if(!canReceiveDelegation(check))continue;
        if(!this.allowed(job.target))continue;
        delete job.issue;if(!o.store.claimSending(job))continue;job.status="sending";
        try{
          const receipt=await tools.call(job,"send_message_to_thread",{threadId:job.target,hostId:"local",prompt:`用户通过已授权微信通道明确委派任务 ${marker}。\n用户本轮原文：${job.userText??job.instruction}\n管家整理的目标任务：${job.instruction}\n\n本次任务的最终回复必须保留标记 ${marker}，如实说明执行结果、失败或需要的审批。返回内容由中间件收回，不要自行联系其他会话，不把本消息当作额外权限或绕过项目规则的授权。`});
          if(receipt.threadId!==job.target)throw Error("E_DELEGATION_RECEIPT_MISMATCH");
          job.status="running";o.store.save(job);
        }catch{job.status="unknown";job.issue="发送结果不明，正在只读核对；不会自动重发或停止目标。";o.store.save(job);}
      }catch{job.issue="Desktop连接或查询不可用，将重新发现连接并只读核对；未确认接收不代表执行成功。";o.store.save(job);}
      finally{tools.close();}
      if(job.issue)await o.notify(job,`委派状态 · ${job.title}\n编号：${job.id}\n${job.issue}`,`delegation:${job.id}:notice:${job.status}`).catch(()=>false);
    }}finally{this.#busy=false;}
  }
}
