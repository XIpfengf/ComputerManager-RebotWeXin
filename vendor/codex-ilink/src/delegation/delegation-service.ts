import {randomUUID} from "node:crypto";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {DatabaseSync} from "node:sqlite";
import type {DesktopTaskCreator} from "./create-task.ts";
import type {DurableTurnAttachment} from "../bridge/turn-input.ts";
import type {DelegationContext,DesktopTools} from "./desktop-tools.ts";
import { listSessionActivity } from "./activity.ts";
export function initializeDelegationPermissions(root:string,accounts:readonly string[]):void {
 const path=join(root,"delegation-permissions.json");if(existsSync(path))return;
 try{writeFileSync(path,JSON.stringify({version:1,accounts:Object.fromEntries(accounts.map(name=>[name,{allowDesktopThreads:[],allowDesktopReadThreads:[]}]))},null,2),{flag:"wx",mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
}

export type DelegationJob=DelegationContext & {id:string;account:string;target:string;title:string;instruction:string;userText?:string;contextToken:string;status:"queued"|"sending"|"running"|"unknown"|"completed"|"delivered"|"cancelled";createdAt:number;targetTurn?:string;historyCursor?:string;result?:string;issue?:string;lastCheckedAt?:number;held?:boolean};
type PendingFollowup={candidates:Array<{id:string;title:string}>;instruction:string;userText:string;createdAt:number;resolvedTurn?:string};
export class DelegationStore {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS delegation_jobs(id TEXT PRIMARY KEY,account TEXT NOT NULL,origin_turn TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(account,origin_turn,target)) STRICT;
    CREATE TABLE IF NOT EXISTS delegation_recent_targets(account TEXT NOT NULL,origin_thread TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,origin_thread)) STRICT;
    CREATE TABLE IF NOT EXISTS delegation_followups(account TEXT NOT NULL,origin_thread TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(account,origin_thread)) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS delegation_active_target ON delegation_jobs(target) WHERE status IN ('sending','running','unknown');`);}
  remember(account:string,thread:string,target:{id:string;title:string},now:number):void{this.db.prepare("INSERT INTO delegation_recent_targets VALUES(?,?,?) ON CONFLICT(account,origin_thread) DO UPDATE SET body=excluded.body").run(account,thread,JSON.stringify({...target,at:now}));}
  clearRecent(account:string,thread:string,now:number):void{this.remember(account,thread,{id:"",title:""},now);}
  recent(account:string,thread:string,now:number):{id:string;title:string}|undefined{const r=this.db.prepare("SELECT body FROM delegation_recent_targets WHERE account=? AND origin_thread=?").get(account,thread);if(!r)return;const t=JSON.parse(r.body as string);return now>=t.at&&now-t.at<=10*60_000?t:undefined;}
  pending(account:string,thread:string):PendingFollowup|undefined{const row=this.db.prepare("SELECT body FROM delegation_followups WHERE account=? AND origin_thread=?").get(account,thread);return row?JSON.parse(row.body as string):undefined;}
  savePending(account:string,thread:string,p:PendingFollowup):void{this.db.prepare("INSERT INTO delegation_followups VALUES(?,?,?) ON CONFLICT(account,origin_thread) DO UPDATE SET body=excluded.body").run(account,thread,JSON.stringify(p));}
  clearPending(account:string,thread:string):void{this.db.prepare("DELETE FROM delegation_followups WHERE account=? AND origin_thread=?").run(account,thread);}
  recover():void{for(const j of this.all())if(j.status==="sending"){j.status="unknown";j.issue="发送回执未确认，正在只读核对；不会自动重发。";this.save(j);}}
  claimSending(j:DelegationJob):boolean{try{return Number(this.db.prepare("UPDATE delegation_jobs SET status='sending',body=? WHERE id=? AND status='queued'").run(JSON.stringify({...j,status:"sending"}),j.id).changes)===1;}catch{return false;}}
  all(account?:string):DelegationJob[]{return (account?this.db.prepare("SELECT body FROM delegation_jobs WHERE account=? ORDER BY rowid").all(account):this.db.prepare("SELECT body FROM delegation_jobs ORDER BY rowid").all()).map(r=>JSON.parse(r.body as string));}
  save(j:DelegationJob):void{this.db.prepare("INSERT INTO delegation_jobs(id,account,origin_turn,target,status,body) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body").run(j.id,j.account,j.turnId,j.target,j.status,JSON.stringify(j));}
}
export type DelegationOptions={creation?:DesktopTaskCreator;account:string;store:DelegationStore;root:string;owner:(id:string)=>string;explicitOwner:(id:string)=>string|undefined;resolve:(selector:string,purpose?:"inspect")=>Promise<Array<{id:string;title:string;updatedAt?:number}>>;readInspection?:(target:string)=>Promise<Record<string,any>>;readResult?:(target:string,turn:string)=>Promise<string>;tools:()=>DesktopTools;notify:(job:DelegationJob,text:string,key:string)=>Promise<boolean>;now?:()=>number;activeBridgeThreads?:()=>readonly string[]};
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
  #desktopGrant(): {allowUnassignedDesktopThreads?: unknown; allowDesktopThreads?: unknown; allowDesktopReadThreads?: unknown} | undefined {
    try {
      const p = JSON.parse(readFileSync(join(this.options.root, "delegation-permissions.json"), "utf8"));
      if (p.version !== 1) return undefined;
      return p.accounts?.[this.options.account];
    } catch {
      return undefined;
    }
  }
  allowed(id:string):boolean{
    const o = this.options;
    if (o.owner(id) === o.account) return true;
    if (o.explicitOwner(id) !== undefined) return false;
    const grant = this.#desktopGrant();
    return grant?.allowUnassignedDesktopThreads === true ||
      (Array.isArray(grant?.allowDesktopThreads) && grant.allowDesktopThreads.includes(id));
  }
  canRead(id:string):boolean{
    if (this.allowed(id)) return true;
    if (this.options.explicitOwner(id) !== undefined) return false;
    const readOnly = this.#desktopGrant()?.allowDesktopReadThreads;
    return Array.isArray(readOnly) && readOnly.includes(id);
  }
  async command(context:DelegationContext,args:unknown,source:{text:string;contextToken:string;attachments?:readonly DurableTurnAttachment[];isLive?:()=>boolean}):Promise<string>{
    if(!args||typeof args!=="object"||Array.isArray(args))throw Error("参数无效");
    const p={...args} as Record<string,unknown>;
    if(p.action==="create"||p.action==="creation_status"){
      if(!this.options.creation)throw Error("Desktop新建能力未配置，未创建会话。");
      return p.action==="create"?this.options.creation.create(context,p,source):this.options.creation.status(context);
    }
    if (p.action === "sessions" || p.action === "activity" || (p.action === "inspect" && p.target === undefined)) {
      if (Object.keys(p).some(key => key !== "action" && key !== "project")) throw Error("会话列表查询只接受 action 和可选的 project。");
      const assertLive = () => {
        if (source.isLive?.() === false) throw Error("会话查询请求已失效");
      };
      assertLive();
      this.options.store.clearRecent(this.options.account, context.threadId, (this.options.now ?? Date.now)());
      const project = p.project;
      if (project !== undefined && (typeof project !== "string" || !project.trim() || project.length > 200)) {
        throw Error("项目名称无效。");
      }
      return JSON.stringify(await listSessionActivity({
        context,
        ...(project ? { project } : {}),
        includeInactive: p.action === "sessions",
        tools: this.options.tools,
        ...(this.options.activeBridgeThreads ? { activeBridgeThreads: this.options.activeBridgeThreads } : {}),
        canRead: id => this.canRead(id),
        assertLive,
      }));
    }
    if(Object.keys(p).some(k=>!["action","target","instruction","jobId"].includes(k)))throw Error("未知参数");
    const o=this.options;
    if(p.action==="inspect"){
      if(p.target!==undefined&&(typeof p.target!=="string"||p.target.length>200))throw Error("查询目标无效");
      const live=()=>{if(source.isLive?.()===false)throw Error("会话查询请求已失效");};live();
      if(typeof p.target==="string"&&/^[0-9a-f-]{36}$/iu.test(p.target)&&!this.canRead(p.target))return JSON.stringify({status:"permission_required",note:"当前微信未获该会话的查询权限；请询问用户是否为该目标授予只读访问。不得改走桌面界面、脚本或数据库绕过通道权限。"});
      o.store.clearRecent(o.account,context.threadId,(o.now??Date.now)());
      let candidates=(await o.resolve(typeof p.target==="string"?p.target:"", "inspect")).filter(t=>this.canRead(t.id));live();
      if(typeof p.target==="string"&&/^[0-9a-f-]{36}$/iu.test(p.target)&&candidates.some(c=>c.id!==p.target))throw Error("查询目标ID不一致，未继续定位。");
      if(candidates.length>1&&typeof p.target==="string"&&p.target.length>0&&source.text.includes(p.target)&&/(?:最近|最新)(?:活动|执行|更新|操作)/u.test(source.text)&&candidates.every(c=>typeof c.updatedAt==="number"&&Number.isFinite(c.updatedAt))){
        const newest=Math.max(...candidates.map(c=>c.updatedAt!));const selected=candidates.filter(c=>c.updatedAt===newest);if(selected.length===1)candidates=selected;
      }
      if(candidates.length!==1)return JSON.stringify({status:candidates.length?"needs_target":"permission_required",candidates,note:candidates.length?"请选择要查询的会话；只返回授权候选，不执行任务。":"当前通道没有可见的目标。历史缺失不代表任务停止；请直接询问目标名称或目标只读授权，不要退回 Computer Use 操作 Codex 界面。"});
      const target=candidates[0]!;const tools=o.readInspection?undefined:o.tools();try{
        if(!this.canRead(target.id))throw Error("目标授权已撤销");live();
        const snapshot=o.readInspection?await o.readInspection(target.id):await tools!.call(context,"read_thread",{threadId:target.id,hostId:"local",turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:2000});live();
        if(snapshot.thread?.id!==undefined&&snapshot.thread.id!==target.id)throw Error("E_DELEGATION_TARGET_MISMATCH");
        if(!this.canRead(target.id))throw Error("目标授权已撤销");
        o.store.remember(o.account,context.threadId,target,(o.now??Date.now)());
        return JSON.stringify({status:"observed",target,selectionBasis:"authorized-target / updatedAt for explicit recent-activity requests; not proof of execution",observedAt:new Date().toISOString(),threadStatus:snapshot.thread?.status,...(snapshot.history?{history:snapshot.history,statusSource:"independent-read-only-observer"}:{}),turns:(Array.isArray(snapshot.turns)?snapshot.turns:[]).slice(0,3).map((t:any)=>({id:t.id,status:t.status,messages:(Array.isArray(t.items)?t.items:[]).filter((i:any)=>i.type==="agentMessage"&&typeof i.text==="string").slice(-3).map((i:any)=>({text:i.text.slice(0,2000),phase:i.phase}))})),note:"只读查询，没有发送任务。状态是本次接口快照，文字为有界节选；旧进度、notLoaded或窗口存在不证明任务当前执行或停止。信息不足时说明证据时间，不改走 Codex 界面自动化。"});
      }finally{tools?.close();}
    }
    if(p.action==="retry"){
      if(!/(催办|催促|重试|继续|开始|执行|投递|retry)/iu.test(source.text)||/(不要|别|先不)/u.test(source.text))throw Error("需要用户本轮明确催办授权。");
      if(source.isLive?.()===false)throw Error("委派请求已失效。");
      const recent=o.store.recent(o.account,context.threadId,(o.now??Date.now)());
      const jobs = o.store.all(o.account).filter(j =>
        j.threadId === context.threadId && !["cancelled", "delivered"].includes(j.status) &&
        (p.jobId ? j.id === p.jobId : !recent?.id || j.target === recent.id));
      if(!jobs.length)return JSON.stringify({status:"not_found",note:"没有可催办的既有委派；未创建重复任务。"});
      if(new Set(jobs.map(j=>j.target)).size!==1)return JSON.stringify({status:"needs_target",jobs:jobs.map(j=>({id:j.id,target:j.title,status:j.status}))});
      const job=jobs.find(j=>j.status==="queued")??jobs.at(-1)!;
      if(job.status==="queued"&&job.held){job.held=false;delete job.issue;o.store.save(job);}
      this.#next=0;await this.tick();const actual=o.store.all(o.account).find(j=>j.id===job.id)!;
      return JSON.stringify({id:actual.id,status:actual.status,issue:actual.issue,targetTurn:actual.targetTurn,reused:true,note:"推进原委派；结果不明或已发送时只读核对，不重复发送，不强制打断。"});
    }
    if(p.action==="list"||p.action==="status"||p.action==="cancel"){
      let jobs=o.store.all(o.account).filter(j=>!p.jobId||j.id===p.jobId);
      if(p.action==="cancel"){
        if(!/(取消|撤销|关停|停止|cancel)/iu.test(source.text)||/(不要|别|先不)/u.test(source.text)||source.isLive?.()===false)throw Error("取消须由用户本轮明确授权。");
        if(!p.jobId||!source.text.includes(String(p.jobId)))jobs=jobs.filter(j=>j.threadId===context.threadId&&j.status==="queued");
        const all=/(全部|所有|都)/u.test(source.text);
        if(!jobs.length&&o.store.pending(o.account,context.threadId)){o.store.clearPending(o.account,context.threadId);return JSON.stringify([{status:"cancelled",pending:true}]);}
        if(jobs.length!==1&&!all)return JSON.stringify({status:"needs_target",note:"存在多个委派，请选择要取消的任务；无需重述任务。",jobs:jobs.map(j=>({id:j.id,target:j.title,status:j.status}))});
        if(jobs.some(j=>j.status!=="queued"))throw Error("只能取消本通道尚未投递的委派；不会停止目标会话。");
        for(const job of jobs){job.status="cancelled";o.store.save(job);}o.store.clearPending(o.account,context.threadId);
      }
      return JSON.stringify(jobs.slice(-20).map(j=>({id:j.id,target:j.title,status:j.status,issue:j.issue,targetTurn:j.targetTurn,lastCheckedAt:j.lastCheckedAt})));
    }
    const now=(o.now??Date.now)();
    const live=()=>{if(source.isLive?.()===false)throw Error("委派请求已失效，未登记新任务。");};
    let target:{id:string;title:string};let userText=source.text;let confirmation:PendingFollowup|undefined;
    if(p.action==="confirm"){
      const pending=o.store.pending(o.account,context.threadId);
      if(!pending||now-pending.createdAt>10*60_000||now<pending.createdAt||(pending.resolvedTurn&&pending.resolvedTurn!==context.turnId))throw Error("没有有效的待确认委派，请说明要联系的会话和任务。");
      const answer=source.text.trim();
      let matches=pending.candidates.filter(c=>answer.includes(c.id)||answer.includes(c.title));
      if(!pending.candidates.length&&typeof p.target==="string"&&p.target.trim()&&answer.includes(p.target))matches=(await o.resolve(p.target)).filter(t=>this.allowed(t.id));
      const yes=/^(是|对|是的|对的|没错|就是它|就是他|就是她|确认|可以|yes|ok)[。！!\s]*$/iu.test(answer);
      const continueStored = /(?:执行|开始|继续|催办)/u.test(answer) &&
        /^(?:那|好的|可以|现在|请|就|你|能否让|帮我|让|它|他|她|开始|继续|执行|吧|呢|催办|安排|一下|马上|立即|这个|任务|委派|委托|了|[，。！？?\s])+$/u.test(answer);
      if(matches.length===1)target=matches[0]!;
      else if((yes||continueStored)&&pending.candidates.length===1)target=pending.candidates[0]!;
      else return JSON.stringify({status:"needs_confirmation",question:"你指的是哪个会话？",candidates:pending.candidates});
      // A confirmation selects the stored request, never model-supplied replacement text.
      let selection=answer.replace(/[「」“”"『』]/gu,"").replace(/[。！!\s]+$/u,"");
      while(/^(是的|我指的是|指的是|没错|就是|确认|是|对)[，,：:\s]*/u.test(selection))selection=selection.replace(/^(是的|我指的是|指的是|没错|就是|确认|是|对)[，,：:\s]*/u,"");
      if(!yes&&!continueStored&&selection!==target.title&&selection!==target.id)throw Error("请确认候选会话；有新任务时应重新登记，不沿用旧确认。");
      if(!this.allowed(target.id))throw Error("该目标授权已撤销，未投递。");
      p.instruction=pending.instruction;userText=`${pending.userText}\n用户确认目标：${source.text}`;confirmation=pending;
    }else{
      if(p.action!=="submit"||typeof p.instruction!=="string"||!p.instruction.trim()||p.instruction.length>16000)throw Error("需要明确任务，任务不得超过16000字符。");
      const explicit=typeof p.target==="string"&&p.target.trim()&&!/^(它|他|她|该会话|那个会话|刚才的会话)$/u.test(p.target)&&source.text.includes(p.target);
      const requestText = source.text.replace(/```[\s\S]*?```|^\s*>[^\r\n]*|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\r\n]*"/gmu, " ");
      if (!/(告诉|转告|沟通|委派|委托|安排|通知|交给|转发给|发送给|发给|发到|让|delegate)/iu.test(requestText) ||
          /(?:不要|别|先不|不用|不必|无需)\s*(?:再|替我|帮我|直接)?\s*(?:告诉|转告|沟通|委派|委托|安排|通知|交给|转发给|发送给|发给|发到|让)/u.test(requestText)) {
        throw Error("未找到用户本轮的明确委派授权。");
      }
      const pronoun = /(?:告诉|转告|通知|让|交给|委派给|委托给|转发给|发送给|发给|发到)\s*(?:[它他她](?![们人])|该会话|那个会话|刚才(?:的|那个)?会话|刚刚(?:的|那个)?会话)/u.test(requestText);
      if(!explicit&&pronoun){
        const jobs=o.store.all(o.account).filter(j=>j.threadId===context.threadId&&j.createdAt<=now&&now-j.createdAt<=24*60*60_000&&j.status!=="cancelled"&&this.allowed(j.target));
        const recent=o.store.recent(o.account,context.threadId,now);
        if (recent?.id && this.canRead(recent.id) && !this.allowed(recent.id) &&
            (!p.target || /^(它|他|她|该会话|那个会话|刚才的会话)$/u.test(String(p.target)) ||
             p.target === recent.id || p.target === recent.title)) {
          live();
          return JSON.stringify({status:"permission_required",note:"当前通道对该会话仅有只读授权。委派执行另需授权，未登记任务。"});
        }
        const candidates=recent?(recent.id&&this.allowed(recent.id)?[recent]:[]):[...new Map(jobs.map(j=>[j.target,{id:j.target,title:j.title}])).values()];
        if(candidates.length!==1){
          live();o.store.savePending(o.account,context.threadId,{candidates,instruction:p.instruction,userText:source.text,createdAt:now});
          return JSON.stringify({status:"needs_confirmation",question:candidates.length?`你说的“它”指哪个会话：${candidates.map(c=>`「${c.title}」`).join("、")}？任务已保留，确认目标后继续。`:"你说的“它”指哪个会话？请告诉我会话名称。",candidates});
        }
        target=candidates[0]!;
        if(typeof p.target==="string"&&p.target.trim()&&!/^(它|他|她|该会话|那个会话|刚才的会话)$/u.test(p.target)&&p.target!==target.id&&p.target!==target.title)throw Error("指定目标与已定位目标不一致，未登记或投递；请重新定位，不能回退到旧委派。");
      }else{
        if(!explicit||typeof p.target!=="string"||p.target.length>200)throw Error("未找到用户本轮对该目标的明确委派授权，请直接询问用户所指会话，不要求重写整条任务。");
        if(/^[0-9a-f-]{36}$/iu.test(p.target)&&!this.allowed(p.target))throw Error("没有找到唯一的授权目标；不读取或投递其他通道会话。");
        const candidates=(await o.resolve(p.target)).filter(t=>this.allowed(t.id));
        if(/^[0-9a-f-]{36}$/iu.test(p.target)&&candidates.some(c=>c.id!==p.target))throw Error("解析目标ID不一致，未登记或投递。");
        if(candidates.length!==1){
          if(!candidates.length)throw Error("没有找到唯一的授权目标；不读取或投递其他通道会话。");
          live();o.store.savePending(o.account,context.threadId,{candidates,instruction:p.instruction,userText:source.text,createdAt:now});
          return JSON.stringify({status:"needs_confirmation",question:"有多个匹配会话，你指的是哪一个？任务已保留，只需确认候选名称或编号。",candidates});
        }
        target=candidates[0]!;
      }
    }
    if(target.id===context.threadId)throw Error("不能委派给当前会话自身。");
    const previous=o.store.all(o.account).find(j=>j.turnId===context.turnId&&j.target===target.id);
    if(previous){if(previous.instruction!==p.instruction)throw Error("本轮已登记该目标的另一任务，请另发一条消息。");return JSON.stringify({id:previous.id,status:previous.status,target:previous.title,targetId:previous.target,reused:true});}
    if(source.isLive?.()===false)throw Error("委派请求已失效，未登记新任务。");
    const job:DelegationJob={...context,id:randomUUID(),account:o.account,target:target.id,title:target.title,instruction:p.instruction as string,userText,contextToken:source.contextToken,status:"queued",createdAt:(o.now??Date.now)()};
    o.store.save(job);if(confirmation)o.store.savePending(o.account,context.threadId,{...confirmation,resolvedTurn:context.turnId});else o.store.clearPending(o.account,context.threadId);return JSON.stringify({id:job.id,status:job.status,target:job.title,targetId:job.target,note:"已持久化排队，尚不代表目标已接收。目标忙碌时不打断；结果核对后回到本微信通道。"});
  }
  async tick():Promise<void>{
    const o=this.options;const now=(o.now??Date.now)();if(this.#busy||now<this.#next)return;this.#busy=true;this.#next=now+5000;
    try{const pending=o.store.all(o.account).filter(j=>!["delivered","cancelled"].includes(j.status));const batch=pending.length?[...pending.slice(this.#offset%pending.length),...pending.slice(0,this.#offset%pending.length)].slice(0,4):[];this.#offset=pending.length?(this.#offset+batch.length)%pending.length:0;for(const job of batch){if(job.held)continue;job.lastCheckedAt=now;
      if(!this.allowed(job.target)){job.issue="目标授权已撤销，暂停投递和读取。";o.store.save(job);await o.notify(job,`委派暂停\n编号：${job.id}\n${job.issue}`,`delegation:${job.id}:revoked`).catch(()=>false);continue;}
      if(job.status==="completed") {if(await o.notify(job,`委派结果 · ${job.title}\n编号：${job.id}\n来源会话：${job.threadId}\n目标回合：${job.targetTurn??"未确认"}\n\n${job.result??""}`,`delegation:${job.id}:result`)){job.status="delivered";o.store.save(job);}continue;}
      const tools=o.tools();
      try{
        const before=await tools.call(job,"read_thread",{threadId:job.target,hostId:"local",turnLimit:1,includeOutputs:job.status!=="queued"&&!job.targetTurn,maxOutputCharsPerItem:2000,...(job.historyCursor?{cursor:job.historyCursor}:{})});
        if(before.thread?.id!==undefined&&before.thread.id!==job.target)throw Error("E_DELEGATION_TARGET_MISMATCH");
        if(job.status==="queued"&&o.store.all(o.account).find(j=>j.id===job.id)?.status!=="queued")continue;
        const marker=`[iLink委派:${job.id}]`;
        if(!job.targetTurn&&job.status!=="queued"){const bound=before.turns?.find((t:any)=>JSON.stringify(t.items).includes(marker));if(bound){job.targetTurn=bound.id;o.store.save(job);}}
        const failed=before.turns?.find((t:any)=>t.id===job.targetTurn&&["failed","interrupted"].includes(t.status));
        if(failed){job.result=`目标委派回合${failed.status==="failed"?"执行失败":"已中断"}，未取得成功结果。未自动重试，也未停止其他任务。`;job.status="completed";o.store.save(job);continue;}
        // Only an exact correlation marker in an actual completed turn can finish a job.
        const found=before.turns?.find((t:any)=>t.status==="completed"&&(t.id===job.targetTurn||t.items?.some((i:any)=>i.type==="agentMessage"&&i.phase==="final_answer"&&i.text?.includes(marker))));
        if(found&&(job.status==="running"||job.status==="unknown")){
          const text:string=o.readResult?await o.readResult(job.target,found.id):found.items.filter((i:any)=>i.type==="agentMessage"&&i.phase==="final_answer").map((i:any)=>i.text).join("\n");if(!text.includes(marker)&&found.id!==job.targetTurn)throw Error("E_DELEGATION_RESULT_MISMATCH");job.targetTurn=found.id;job.result=text||"目标回合已结束，但没有最终文字结果，不能据此声称操作成功。";job.status="completed";delete job.issue;delete job.historyCursor;o.store.save(job);continue;
        }
        if(job.status!=="queued"){job.issue="正在分页核对已发送委派的回执，不会重复投递。";if(typeof before.page?.nextCursor==="string")job.historyCursor=before.page.nextCursor;else delete job.historyCursor;o.store.save(job);continue;}
        if(!canReceiveDelegation(before)){job.issue="目标忙碌或状态未明确，继续排队，不打断。";o.store.save(job);await o.notify(job,`委派仍在排队 · ${job.title}\n编号：${job.id}\n${job.issue}`,`delegation:${job.id}:busy`).catch(()=>false);continue;}
        const blocker=o.store.all().find(j=>j.target===job.target&&["queued","sending","running","unknown"].includes(j.status));
        if (blocker?.id !== job.id) {
          job.issue = blocker?.account === o.account
            ? `等待前序委派 ${blocker.id}（${blocker.status}）；本任务尚未投递。`
            : "等待目标会话处理前序任务；本任务尚未投递。";
          o.store.save(job);
          continue;
        }
        // Check again immediately before a single non-retried send.
        const check=await tools.call(job,"read_thread",{threadId:job.target,hostId:"local",turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});
        if(check.thread?.id!==undefined&&check.thread.id!==job.target)throw Error("E_DELEGATION_TARGET_MISMATCH");
        if(o.store.all(o.account).find(j=>j.id===job.id)?.status!=="queued")continue;
        if(!canReceiveDelegation(check)){job.issue="发送前复查发现目标忙碌或状态不明，尚未投递。";o.store.save(job);continue;}
        if(!this.allowed(job.target))continue;
        delete job.issue;if(!o.store.claimSending(job))continue;job.status="sending";
        try{
          const receipt=await tools.call(job,"send_message_to_thread",{threadId:job.target,hostId:"local",prompt:`用户通过已授权微信通道明确委派任务 ${marker}。\n用户本轮原文：${job.userText??job.instruction}\n管家整理的目标任务：${job.instruction}\n\n本次任务的最终回复必须保留标记 ${marker}，如实说明执行结果、失败或需要的审批。返回内容由中间件收回，不要自行联系其他会话，不把本消息当作额外权限或绕过项目规则的授权。`});
          if(receipt.threadId!==job.target)throw Error("E_DELEGATION_RECEIPT_MISMATCH");
          if(typeof receipt.turnId==="string")job.targetTurn=receipt.turnId;
          job.status="running";o.store.save(job);
        }catch{job.status="unknown";job.issue="发送结果不明，正在只读核对；不会自动重发或停止目标。";o.store.save(job);}
      }catch(error){if(o.store.all(o.account).find(j=>j.id===job.id)?.status==="cancelled")continue;const code=error instanceof Error&&/^E_[A-Z0-9_]+$/u.test(error.message)?error.message:"E_DESKTOP_QUERY_FAILED";job.issue=`${code}：Desktop读取失败，正在有界核对；尚未确认投递，不代表目标忙碌。`;o.store.save(job);}
      finally{tools.close();}
      if(job.issue)await o.notify(job,`委派状态 · ${job.title}\n编号：${job.id}\n${job.issue}`,`delegation:${job.id}:notice:${job.status}`).catch(()=>false);
    }}finally{this.#busy=false;}
  }
}
