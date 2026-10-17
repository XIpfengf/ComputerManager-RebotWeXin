import { randomBytes, randomUUID } from "node:crypto";
import type { AccountStore } from "../accounts/account-store.ts";
import type { CodexRuntime } from "../codex/codex-runtime.ts";
import type { SqliteState } from "../bridge/sqlite-state.ts";
import type { SqliteTurnLeaseStore } from "../coordination/turn-lease.ts";

const DAY = 86400000;
type Policy = { enabled: boolean; idleDays: number; keepRecent: number; revision: number; lastScan: number };
type Candidate = { id: string; title: string; activity: number };
type Preview = { candidates: Candidate[]; excluded: Array<{ id: string; reason: string }> };
export interface HistoryPort { command(text: string): Promise<string>; tick(): Promise<void>; }
export const HISTORY_HELP = ["history policy — 查看归档规则", "history enable / disable — 开启/关闭每日自动归档（默认关闭）", "history preview — 预览30天未活动且不在最近20条中的候选", "history archive — 生成本次预览的一次确认码", "history archive confirm <码> — 两分钟内确认", "history pin <会话ID> / unpin <会话ID> — 固定保留/取消固定", "history restore <会话ID> — 恢复归档，不切换当前会话", "history reconcile — 对账未确认的操作", "history help — 帮助；不提供永久删除命令"].join("\n");

/** Per-account lifecycle controller. Native archive only; never deletes transcripts or files. */
export class HistoryService implements HistoryPort {
  readonly options: { accounts: AccountStore; account: string; codex: CodexRuntime; state: SqliteState; leases: SqliteTurnLeaseStore; instanceId: string; now: () => number; approvalBusy?: (id: string) => boolean; desktopPinned?: (id: string) => boolean; notify?: (text: string, id: string) => Promise<void> };
  #tail: Promise<unknown> = Promise.resolve();
  #confirmation: { code: string; revision: number; expires: number; candidates: Candidate[] } | undefined;
  constructor(options: HistoryService["options"]) {
    this.options = options;
    options.accounts.database.exec(`CREATE TABLE IF NOT EXISTS history_policies(account TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,last_scan INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS history_pins(account TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(account,thread_id)) STRICT;
      CREATE TABLE IF NOT EXISTS history_operations(id TEXT PRIMARY KEY,account TEXT NOT NULL,thread_id TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,detail TEXT NOT NULL) STRICT;`);
    options.accounts.database.prepare("INSERT OR IGNORE INTO history_policies(account) VALUES(?)").run(options.account);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const work=this.#tail.then(fn);this.#tail=work.catch(()=>{});return work; }
  policy(): Policy { const r=this.options.accounts.database.prepare("SELECT enabled,revision,last_scan FROM history_policies WHERE account=?").get(this.options.account)!;return { enabled:r.enabled===1,revision:Number(r.revision),lastScan:Number(r.last_scan),idleDays:30,keepRecent:20 }; }
  private owned(id: string): boolean { return !!this.options.accounts.database.prepare("SELECT 1 FROM thread_accounts WHERE thread_id=? AND account_name=?").get(id,this.options.account); }
  private pins(id: string): boolean { return !!this.options.accounts.database.prepare("SELECT 1 FROM history_pins WHERE account=? AND thread_id=?").get(this.options.account,id); }
  private protectedReason(id: string, ownOperation?: string): string | null {
    const {state,leases,now}=this.options;
    if (!this.owned(id)) return "不属于本通道托管线程";
    if (state.getBridgeSettings().mainThreadId===id) return "主会话";
    if (state.getBinding(now())?.threadId===id) return "当前会话";
    if (this.pins(id)) return "固定保留";
    if (this.options.desktopPinned?.(id)) return "Desktop固定保留";
    const lease=leases.getLease(id);if(lease && lease.operationId!==ownOperation)return "存在执行租约";
    if (state.hasActiveDispatchForThread(id)||state.peekQueuedTurn(id)||state.getDesktopTurnObservation(id)||this.options.approvalBusy?.(id))return "执行中、排队或待审批";
    if (state.listPendingDesktopNotifications().some(n=>n.threadId===id)||state.listTerminalNotificationJobs(now()).some(n=>n.threadId===id))return "待投递通知";
    // An opaque pending body may be an attachment or task result: conservatively protect all threads.
    if (state.listPendingOutbox().length || state.listOutboundAttachmentPathKeys().length)return "存在待交付结果或附件";
    return null;
  }
  private async list(archived: boolean): Promise<Array<Record<string,unknown>>> {
    const rows: Array<Record<string,unknown>>=[];const seen=new Set<string>();let cursor: string|null=null;
    do {const p=await this.options.codex.listThreads({archived,...(cursor?{cursor}:{})});for(const raw of p.data){if(raw&&typeof raw==="object"&&typeof (raw as {id?:unknown}).id==="string"&&this.owned((raw as {id:string}).id))rows.push(raw as Record<string,unknown>);}cursor=p.nextCursor;if(cursor){if(seen.has(cursor)||seen.size>=1000)throw new Error("会话分页异常，未执行归档");seen.add(cursor);}}while(cursor);return rows;
  }
  private async activity(id: string): Promise<{ at: number; busy: boolean; pinned: boolean }> {
    const {thread}=await this.options.codex.readThread({threadId:id,includeTurns:true});
    const status=thread.status as {type?:string}|undefined;
    if(status?.type!=="idle"&&status?.type!=="notLoaded")return {at:0,busy:true,pinned:false};
    let at=0;for(const t of Array.isArray(thread.turns)?thread.turns:[]){const turn=t as Record<string,unknown>;const items=Array.isArray(turn.items)?turn.items:[];
      if(!items.some(i=>["userMessage","agentMessage"].includes(String((i as {type?:string}).type))))continue;
      if(!["completed","failed","interrupted"].includes(String(turn.status)))return {at:0,busy:true,pinned:false};
      for(const key of ["completedAt","startedAt"]){const value=turn[key];if(typeof value==="number"&&Number.isFinite(value)&&value>0){const time=value<1e12?value*1000:value;if(time<=this.options.now()+60000)at=Math.max(at,time);}}
    }return {at,busy:false,pinned:thread.isPinned===true||thread.is_pinned===true};
  }
  async preview(): Promise<Preview> {
    const excluded: Preview["excluded"]=[], measured: Candidate[]=[];
    for(const row of await this.list(false)){const id=String(row.id);try{const a=await this.activity(id);if(!a.at||a.busy){excluded.push({id,reason:"无可靠活动时间或非空闲状态"});continue;}measured.push({id,title:typeof row.name==="string"?row.name:typeof row.preview==="string"?row.preview.slice(0,80):id,activity:a.at});if(a.pinned||row.isPinned===true||row.is_pinned===true)excluded.push({id,reason:"Desktop固定保留"});}catch{excluded.push({id,reason:"原生读取失败"});}}
    measured.sort((a,b)=>b.activity-a.activity||a.id.localeCompare(b.id));
    const recent=new Set(measured.slice(0,20).map(t=>t.id));const candidates: Candidate[]=[];
    for(const t of measured){if(excluded.some(e=>e.id===t.id))continue;const reason=this.protectedReason(t.id)??(recent.has(t.id)?"最近20个会话":null)??(t.activity>this.options.now()-30*DAY?"未满30天":null)??(this.unresolved(t.id)?"存在待对账操作":null);if(reason)excluded.push({id:t.id,reason});else candidates.push(t);}
    return {candidates,excluded};
  }
  private unresolved(id:string): boolean { return !!this.options.accounts.database.prepare("SELECT 1 FROM history_operations WHERE account=? AND thread_id=? AND status IN ('pending','unknown')").get(this.options.account,id); }
  private record(id:string,thread:string,operation:string):void {this.options.accounts.database.prepare("INSERT INTO history_operations VALUES(?,?,?,?,?,?,?)").run(id,this.options.account,thread,operation,"pending",this.options.now(),"");}
  private result(id:string,status:string,detail=""):void {this.options.accounts.database.prepare("UPDATE history_operations SET status=?,detail=? WHERE id=? AND account=?").run(status,detail,id,this.options.account);}
  private async apply(candidates:Candidate[]):Promise<string> {
    const current=await this.preview();const eligible=new Map(current.candidates.map(c=>[c.id,c]));let archived=0,skipped=0,unknown=0;
    for(const c of candidates){const fresh=eligible.get(c.id);if(!fresh||fresh.activity!==c.activity||this.protectedReason(c.id)){skipped++;continue;}
      const id=randomUUID();const lease=this.options.leases.tryAcquire({threadId:c.id,owner:"bridge",instanceId:this.options.instanceId,operationId:id,turnId:null,createdAtMs:this.options.now()});if(!lease.acquired){skipped++;continue;}
      try{const a=await this.activity(c.id);if(a.busy||a.pinned||a.at!==c.activity||this.protectedReason(c.id,id)){skipped++;continue;}
        this.record(id,c.id,"archive");try{await this.options.codex.archiveThread(c.id);this.result(id,"confirmed");archived++;}catch{this.result(id,"unknown","接口结果未确认，需先对账");unknown++;}
      }finally{this.options.leases.release(lease.lease);}
    }return `归档完成：成功 ${archived}，条件变化跳过 ${skipped}，待对账 ${unknown}。没有删除历史或文件，也未切换当前会话。`;
  }
  private async reconcile():Promise<string> {
    const pending=this.options.accounts.database.prepare("SELECT id,thread_id,operation FROM history_operations WHERE account=? AND status IN ('pending','unknown')").all(this.options.account) as Array<{id:string;thread_id:string;operation:string}>;
    if(!pending.length)return "没有待对账操作。";
    const archived=new Set((await this.list(true)).map(t=>String(t.id)));const active=new Set((await this.list(false)).map(t=>String(t.id)));let count=0;
    for(const p of pending){if(!this.owned(p.thread_id))continue;const desired=p.operation==="archive"?archived:active;const opposite=p.operation==="archive"?active:archived;
      if(desired.has(p.thread_id)){this.result(p.id,"confirmed","通过原生列表核实");count++;}
      else if(opposite.has(p.thread_id)&&this.options.now()-this.operationTime(p.id)>60000){this.result(p.id,"not-applied","观察到相反状态，未自动重发；可重新预览确认");count++;}}
    return `已对账 ${count} 项；未确认的仍保留，不盲目重发。`;
  }
  private operationTime(id:string):number {return Number(this.options.accounts.database.prepare("SELECT created_at FROM history_operations WHERE id=? AND account=?").get(id,this.options.account)?.created_at??this.options.now());}
  async tick():Promise<void>{await this.serial(async()=>{const p=this.policy();if(!p.enabled||this.options.now()-p.lastScan<DAY)return;
    // Persist attempt time before scanning so repeated network failures cannot create a tight retry loop.
    this.options.accounts.database.prepare("UPDATE history_policies SET last_scan=? WHERE account=?").run(this.options.now(),this.options.account);
    let result:string;let status="confirmed";
    try{await this.reconcile();result=await this.apply((await this.preview()).candidates);}
    catch(e){status="failed";result=`归档扫描未完成：${e instanceof Error?e.message.slice(0,200):"接口不可用"}。未执行删除，已停止本次扫描。`;}
    const id=this.recordSummary(result,status);await this.options.notify?.(result,`codex-ilink:history-scan-${id}`);
  });}
  private recordSummary(detail:string,status="confirmed"):string{const id=randomUUID();this.record(id,"","scan");this.result(id,status,detail);return id;}
  async command(text:string):Promise<string>{return this.serial(async()=>{try{return await this.execute(text.trim());}catch(e){return `历史操作失败：${e instanceof Error?e.message:"未知错误"}；未执行删除。`;}});}
  private async execute(text:string):Promise<string>{const action=text.replace(/^history\b\s*/u,"");const p=this.policy();
    if(!action||action==="help")return HISTORY_HELP;
    if(action==="policy"){const last=this.options.accounts.database.prepare("SELECT detail FROM history_operations WHERE account=? AND operation='scan' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(this.options.account);return `自动归档：${p.enabled?"开启":"关闭"}；每天扫描一次；闲置30天，至少保留最近20个未归档会话。\n当前/主/固定/忙碌/待交付会话排除。仅本通道托管线程，归档不是删除。\n最近扫描：${p.lastScan?new Date(p.lastScan).toISOString():"尚未扫描"}${last?`\n${last.detail}`:""}`;}
    if(action==="enable"||action==="disable"){this.options.accounts.database.prepare("UPDATE history_policies SET enabled=?,revision=revision+1 WHERE account=?").run(action==="enable"?1:0,this.options.account);this.#confirmation=undefined;return `本通道自动归档已${action==="enable"?"开启":"关闭"}。历史不会被删除。`;}
    if(action==="reconcile")return this.reconcile();
    if(action==="preview"||action==="archive"){const v=await this.preview();const lines=[`候选 ${v.candidates.length} 项，排除 ${v.excluded.length} 项。`,...v.candidates.map(c=>`${c.id} · ${c.title} · ${new Date(c.activity).toISOString()}`),...v.excluded.map(c=>`保留 ${c.id}：${c.reason}`)];
      if(action==="archive"&&v.candidates.length){this.#confirmation={code:randomBytes(4).toString("hex").toUpperCase(),revision:p.revision,expires:this.options.now()+120000,candidates:v.candidates};lines.push(`两分钟内发送 history archive confirm ${this.#confirmation.code}；仅处理以上候选。`);}return lines.join("\n");}
    if(action.startsWith("archive confirm ")){const c=this.#confirmation;this.#confirmation=undefined;if(!c||c.expires<=this.options.now()||c.revision!==p.revision||action!==`archive confirm ${c.code}`)throw new Error("确认码无效或过期，请重新 history archive");return this.apply(c.candidates);}
    const match=/^(pin|unpin|restore) ([a-zA-Z0-9-]+)$/u.exec(action);if(match){const id=match[2]!;if(!this.owned(id))throw new Error("只能操作本通道明确托管的会话");this.#confirmation=undefined;
      if(match[1]==="pin"){this.options.accounts.database.prepare("INSERT OR IGNORE INTO history_pins VALUES(?,?)").run(this.options.account,id);return "已固定保留该会话。";}
      if(match[1]==="unpin"){this.options.accounts.database.prepare("DELETE FROM history_pins WHERE account=? AND thread_id=?").run(this.options.account,id);return "已取消本通道固定保留。";}
      if(this.protectedReason(id)||this.unresolved(id))throw new Error("会话受保护、忙碌或待对账，未恢复");
      if(!(await this.list(true)).some(t=>t.id===id))throw new Error("该会话不在归档列表");
      const operation=randomUUID();const lease=this.options.leases.tryAcquire({threadId:id,owner:"bridge",instanceId:this.options.instanceId,operationId:operation,turnId:null,createdAtMs:this.options.now()});if(!lease.acquired)throw new Error("会话正在使用");
      try{if(this.protectedReason(id,operation))throw new Error("会话状态发生变化");this.record(operation,id,"restore");try{await this.options.codex.unarchiveThread(id);this.result(operation,"confirmed");return "已恢复归档会话；身份快照不变，当前会话未切换。用 s 列表进入。";}catch{this.result(operation,"unknown");return "恢复结果未确认，请 history reconcile 对账；未自动重发。";}}finally{this.options.leases.release(lease.lease);}}
    return HISTORY_HELP;
  }
}
