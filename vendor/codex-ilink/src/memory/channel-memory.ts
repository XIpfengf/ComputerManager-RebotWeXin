import type { AccountStore } from "../accounts/account-store.ts";
import { createHash } from "node:crypto";
import { MemoryProvenance, type SourceKind } from "./provenance.ts";
import { MemoryExtractionQueue, admissibleStatement, type MemoryExtractor } from "./extraction.ts";
import { memoryId, storeFact } from "./facts.ts";
import { semanticKey,semanticValue } from "./semantics.ts";
import {DEFAULT_RECALL_WEIGHTS,rankMemories,recallTimeIntent,type RecallWeights,type RecalledMemory} from "./retrieval.ts";
import { initializeForgetting, forgetFact } from "./forget.ts";
import { MemoryBackfill, type MemoryHistoryReader } from "./backfill.ts";
import type {TurnContext} from "../codex/protocol.ts";

export type MemoryContext = Record<string, { kind: "untrusted"; value: string }>;
export type MemoryPolicySnapshot = { revision: number; enabled: boolean; autoEnabled: boolean; unavailable?: true; interactionRevision?:number };
export type MemorySource = { threadId: string; messageId: string; nowMs: number; kind?: SourceKind; text?: string; policy?: MemoryPolicySnapshot };
export interface MemoryPort {
  command(text: string, source: MemorySource): Promise<string>;
  context(threadId: string, query?: string): MemoryContext;
  prepareContext?(source:MemorySource):TurnContext;
  recordTurn(source: MemorySource, turnId: string): void;
  recordReference(threadId: string, turnId: string, eventId: string): void;
  recordAssistant(threadId: string, turnId: string): void;
  tick(): Promise<void>;
  snapshot(): MemoryPolicySnapshot;
  makePrivate(threadId: string): void;
}
export const MEMORY_HELP = [
  "memory enable — 开启本通道显式记忆（默认关闭）",
  "memory remember <我自己的明确陈述> — 仅纯文字本人陈述；不接受引用、附件或工具资料",
  "memory show — 查看记忆与来源；memory status — 查看状态",
  "memory help — 帮助；不会自动回填历史，提炼需要单独开启",
  "memory auto enable / disable / status — 单独开启/关闭后台提炼或查看预算与作业；需要已配置无工具 HTTP 后端",
  "memory auto reconcile / cancel — 本地核对未知作业 / 取消尚未确认的提炼；未知结果不自动重试",
  "memory source <记忆ID> — 查看原话与旧版本；memory correct <记忆ID> <修订> <本人新陈述> — 明确纠正",
  "memory profile — 按有效事实重建用户画像；memory forget <记忆ID> <修订> — 遗忘（不删除原始对话）",
  "memory candidates — 查看待确认候选；可用correct加本人新陈述明确确认",
  "memory disable — 停止记忆采集、提炼和注入；已有事实保留，旧模型上下文不会因此被删除",
  "memory private — 新建无记忆临时会话；new 新建普通会话，exit 返回主会话。临时历史永久排除回填",
  "memory export [游标] — 分页导出本通道有效记忆与来源；期间发生修改需重新导出",
  "memory backfill preview [会话ID] / start <码> / status / pause / resume / cancel — 显式有限回填；未知来源跳过",
].join("\n");
export const MEMORY_CONTEXT_KEY = "ilink.channel-memory";
export const MEMORY_CONTEXT_BYTES = 4096;

/** Explicit control messages only. Never reads transcripts or modifies identity. */
export class ChannelMemory implements MemoryPort {
  readonly accounts: AccountStore;
  readonly account: string;
  readonly provenance: MemoryProvenance;
  readonly extraction: MemoryExtractionQueue | undefined;
  readonly backfill: MemoryBackfill | undefined;
  readonly now:()=>number;
  constructor(accounts: AccountStore, account: string, options: { extractor?: MemoryExtractor; historyReader?: MemoryHistoryReader; now?: () => number; extractionTimeoutMs?: number } = {}) {
    this.accounts = accounts; this.account = account;this.now=options.now??Date.now;
    this.provenance = new MemoryProvenance(accounts, account);
    if (!accounts.list().some(a => a.name === account)) throw Error("E_MEMORY_ACCOUNT");
    accounts.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_policies(account TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS channel_memories(
        account TEXT NOT NULL, subject TEXT NOT NULL, content TEXT NOT NULL,
        thread_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(account,message_id)
      ) STRICT;`);
    for (const [table, name, declaration] of [
      ["memory_policies", "auto_enabled", "INTEGER NOT NULL DEFAULT 0"],
      ["memory_policies", "revision", "INTEGER NOT NULL DEFAULT 1"],
      ["channel_memories", "category", "TEXT NOT NULL DEFAULT 'preference'"],
      ["channel_memories", "status", "TEXT NOT NULL DEFAULT 'active'"],
      ["channel_memories", "memory_id", "TEXT"],
      ["channel_memories", "revision", "INTEGER NOT NULL DEFAULT 1"],
      ["channel_memories", "semantic_key", "TEXT NOT NULL DEFAULT ''"],
      ["channel_memories", "evidence_type", "TEXT NOT NULL DEFAULT 'explicit'"],
      ["channel_memories", "supersedes", "TEXT"],
      ["channel_memories", "valid_from", "INTEGER NOT NULL DEFAULT 0"],
      ["channel_memories", "valid_until", "INTEGER"],
      ["channel_memories", "content_hash", "TEXT"],
    ] as const) {
      if (!accounts.database.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) accounts.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
    }
    for (const row of accounts.database.prepare("SELECT account,message_id,content FROM channel_memories WHERE account=? AND status!='forgotten' AND (memory_id IS NULL OR semantic_key='')").all(account)) accounts.database.prepare("UPDATE channel_memories SET memory_id=?,semantic_key=? WHERE account=? AND message_id=?").run(memoryId(String(row.account), String(row.message_id)), semanticKey(String(row.content)), row.account!, row.message_id!);
    accounts.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS channel_memory_ids ON channel_memories(memory_id)");
    accounts.database.prepare("UPDATE channel_memories SET valid_from=created_at WHERE account=? AND valid_from=0").run(account);
    initializeForgetting(accounts);
    accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_recall_settings(account TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS memory_recall_receipts(account TEXT NOT NULL,thread_id TEXT NOT NULL,request_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account,thread_id,request_id)) STRICT;`);
    if(!accounts.database.prepare("PRAGMA table_info(memory_recall_settings)").all().some(x=>x.name==="revision"))accounts.database.exec("ALTER TABLE memory_recall_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_private_threads(account TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(account,thread_id)) STRICT;
      CREATE TABLE IF NOT EXISTS memory_inputs(account TEXT NOT NULL,message_id TEXT NOT NULL,thread_id TEXT NOT NULL,policy_revision INTEGER NOT NULL,excluded INTEGER NOT NULL,captured_at INTEGER NOT NULL,text_hash TEXT,source_kind TEXT NOT NULL,PRIMARY KEY(account,message_id)) STRICT;
      CREATE TABLE IF NOT EXISTS memory_policy_events(account TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,changed_at INTEGER NOT NULL,PRIMARY KEY(account,revision)) STRICT;`);
    this.extraction = options.extractor ? new MemoryExtractionQueue({ accounts, account, provenance: this.provenance, extractor: options.extractor, ...(options.now ? { now: options.now } : {}), ...(options.extractionTimeoutMs !== undefined ? { timeoutMs: options.extractionTimeoutMs } : {}) }) : undefined;
    this.backfill = options.historyReader && this.extraction ? new MemoryBackfill({ accounts, account, history: options.historyReader, provenance: this.provenance, policy: () => this.snapshot(), allowedThread: id => this.owned(id) && !this.isPrivate(id), mayBackfill: (thread, message, text) => this.mayBackfill(thread, message, text), enqueue: input => this.extraction!.enqueue(input, "backfill"), now: options.now ?? Date.now }) : undefined;
  }
  private owned(id: string): boolean { return this.accounts.explicitOwner(id) === this.account; }
  private enabled(): boolean { return this.snapshot().enabled; }
  snapshot(): MemoryPolicySnapshot {
    const p = this.accounts.database.prepare("SELECT enabled,auto_enabled,revision FROM memory_policies WHERE account=?").get(this.account);
    if (p && (![0, 1].includes(Number(p.enabled)) || ![0, 1].includes(Number(p.auto_enabled)) || !Number.isSafeInteger(p.revision) || Number(p.revision) < 1)) throw Error("E_MEMORY_POLICY_INVALID");
    return { enabled: p?.enabled === 1, autoEnabled: p?.auto_enabled === 1, revision: Number(p?.revision ?? 0) };
  }
  private isPrivate(threadId: string): boolean { return !!this.accounts.database.prepare("SELECT 1 FROM memory_private_threads WHERE account=? AND thread_id=?").get(this.account, threadId); }
  makePrivate(threadId: string): void {
    if (!this.owned(threadId)) throw Error("E_MEMORY_PRIVATE_OWNERSHIP");
    if (this.isPrivate(threadId)) return;
    if (this.accounts.database.prepare("SELECT 1 FROM memory_sources WHERE account=? AND thread_id=?").get(this.account, threadId) || this.accounts.database.prepare("SELECT 1 FROM memory_inputs WHERE account=? AND thread_id=?").get(this.account, threadId)) throw Error("E_MEMORY_PRIVATE_REQUIRES_NEW_THREAD");
    this.accounts.database.prepare("INSERT INTO memory_private_threads VALUES(?,?)").run(this.account, threadId);
    this.accounts.database.prepare("UPDATE memory_policies SET revision=revision+1 WHERE account=?").run(this.account);
  }
  mayBackfill(threadId: string, messageId: string, text?: string): boolean {
    if (!this.enabled() || !this.owned(threadId) || this.isPrivate(threadId)) return false;
    const input = this.accounts.database.prepare("SELECT excluded,text_hash FROM memory_inputs WHERE account=? AND thread_id=? AND message_id=?").get(this.account, threadId, messageId);
    return input?.excluded === 0 && this.provenance.check(`wechat:${messageId}`, threadId).eligible && (text === undefined || input.text_hash === createHash("sha256").update(text).digest("hex"));
  }
  private entries(query?: string) {
    // Recheck evidence ownership on every read, including after a state reopen.
    this.provenance.reconcileOwnership();
    const historical=recallTimeIntent(query)==="earliest";
    return this.verifiedRows(this.accounts.database.prepare(`SELECT m.memory_id AS id,m.subject,m.content,m.content_hash AS contentHash,m.category,m.status,m.revision,m.supersedes,m.evidence_type AS evidenceType,m.valid_from AS validFromMs,m.valid_until AS validUntilMs,m.thread_id AS threadId,m.message_id AS messageId,m.created_at AS createdAtMs,
      (SELECT turn_id FROM memory_turn_sources ts WHERE ts.account=m.account AND ts.thread_id=m.thread_id AND ts.source_id='wechat:'||m.message_id LIMIT 1) AS turnId
      FROM channel_memories m JOIN thread_accounts t ON t.thread_id=m.thread_id AND t.account_name=m.account
      WHERE m.account=? AND m.status IN ('active','conflict'${historical?",'superseded'":""}) ORDER BY ${historical?"m.created_at ASC":"CASE WHEN m.evidence_type='correction' THEN 0 ELSE 1 END,m.created_at DESC"},m.message_id DESC LIMIT 1000`).all(this.account));
  }
  private verifiedRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.filter(row => this.provenance.check(`wechat:${row.messageId}`, String(row.threadId)).eligible).map(row => {
      if (typeof row.content !== "string" || row.contentHash !== createHash("sha256").update(row.content).digest("hex") || row.subject !== "user" || !["preference", "decision", "event"].includes(String(row.category)) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw Error("E_MEMORY_FACT_INTEGRITY");
      const { contentHash: _contentHash, ...fact } = row; return fact;
    });
  }
  async command(text: string, source: MemorySource): Promise<string> {
    if (!this.owned(source.threadId)) return "记忆操作拒绝：无法核实当前会话归属。";
    if (text === "memory" || text === "memory help") return MEMORY_HELP;
    if (this.isPrivate(source.threadId)) return "当前为无记忆临时会话，不读取或记录通道记忆；发送 new 新建普通会话，exit 返回主会话。";
    if(text==="memory explain")return JSON.stringify(this.explain(source.threadId));
    if(text.startsWith("memory recall set ")){
      if(source.kind!=="channel-original")return "未修改：设置必须来自本通道原始纯文字。";
      const match=/^memory recall set (relevance|time|explicit) ([0-5])$/u.exec(text);if(!match)return "格式：memory recall set relevance|time|explicit 0–5";
      const weights={...this.recallWeights(),[match[1]!]:Number(match[2])};this.setRecallWeights(this.recallRevision(),weights);return "已更新本通道召回排序；来源资格与纠正优先级不变。";
    }
    if(text.startsWith("memory recall "))return JSON.stringify(this.recall(source.threadId,text.slice(14),source.messageId));
    if (text === "memory enable") {
      this.accounts.database.prepare("INSERT INTO memory_policies(account,enabled) VALUES(?,1) ON CONFLICT(account) DO UPDATE SET enabled=1,revision=revision+CASE WHEN enabled=0 THEN 1 ELSE 0 END").run(this.account);
      const p = this.snapshot();
      this.accounts.database.prepare("INSERT OR IGNORE INTO memory_policy_events VALUES(?,?,1,?)").run(this.account, p.revision, source.nowMs);
      return "已开启本通道记忆。后台提炼需要单独开启，不会自动回填关闭期间历史。";
    }
    if (text === "memory disable") {
      this.accounts.database.prepare("INSERT INTO memory_policies(account,enabled) VALUES(?,0) ON CONFLICT(account) DO UPDATE SET enabled=0,auto_enabled=0,revision=revision+1").run(this.account);
      this.extraction?.cancel();
      const p = this.snapshot();
      this.accounts.database.prepare("INSERT INTO memory_policy_events VALUES(?,?,0,?)").run(this.account, p.revision, source.nowMs);
      return "已关闭通道记忆：停止采集、提炼、回填和动态注入，已有事实保留。原始对话和已进入旧模型上下文的片段不会因此删除。";
    }
    if (text === "memory status") {
      const p = this.accounts.database.prepare("SELECT auto_enabled FROM memory_policies WHERE account=?").get(this.account);
      return `记忆${this.enabled() ? "已开启" : "未开启"}；自动采集${!this.extraction ? "不可用" : p?.auto_enabled === 1 ? "已开启" : "已关闭"}。`;
    }
    if (text === "memory backfill" || text.startsWith("memory backfill ")) return this.backfill?.command(text) ?? "未配置无工具提炼后端或有界历史接口，回填不可用。";
    if (text === "memory auto status") return JSON.stringify(this.extraction?.status() ?? { status: "unavailable" });
    if (text === "memory auto reconcile") return this.extraction?.reconcile() ?? "未配置无工具提炼后端。";
    if (text === "memory auto cancel") {
      this.accounts.database.prepare("UPDATE memory_policies SET revision=revision+1 WHERE account=?").run(this.account);
      this.extraction?.cancel(); return "已取消待处理和未知提炼，原始对话及已有事实未删除。";
    }
    if (text === "memory auto enable" || text === "memory auto disable") {
      if (!this.enabled()) return "记忆未开启。";
      if (!this.extraction) return "未配置无工具提炼后端，自动采集不可用。";
      this.accounts.database.prepare("UPDATE memory_policies SET auto_enabled=?,revision=revision+1 WHERE account=?").run(text.endsWith("enable") ? 1 : 0, this.account);
      return text.endsWith("enable") ? "已开启后台提炼，仅处理之后的合格原话。" : "已关闭后台提炼，显式记忆保留；在途旧结果失效。";
    }
    if (text === "memory show") return this.enabled() ? JSON.stringify({ memories: this.entries().slice(0,100), note: "最近100条有效或冲突记忆。控制消息不创建 Codex 回合，其 turnId 为 null。" }) : "记忆未开启。";
    if (text === "memory profile") {
      if (!this.enabled()) return "记忆未开启。";
      const facts = this.entries().slice(0,100);
      return JSON.stringify({ subject: "user", revision: this.accounts.database.prepare("SELECT revision FROM memory_policies WHERE account=?").get(this.account)?.revision, facts: facts.filter(f => f.status === "active"), conflicts: facts.filter(f => f.status === "conflict"), projectionLimit: 100, note: "按有效证据重建的有界投影，最多100条；完整事实使用export分页。不修改角色身份或背景。" });
    }
    if (text === "memory candidates") {
      if (!this.enabled()) return "记忆未开启。";
      this.provenance.reconcileOwnership();
      const rows = this.accounts.database.prepare("SELECT memory_id AS id,subject,content,content_hash AS contentHash,category,status,revision,thread_id AS threadId,message_id AS messageId,created_at AS createdAtMs FROM channel_memories WHERE account=? AND status='candidate' ORDER BY created_at DESC LIMIT 100").all(this.account);
      return JSON.stringify({ memories: this.verifiedRows(rows), note: "候选不参与自动注入；用correct及新的本人明确陈述确认，或forget遗忘。" });
    }
    if (text === "memory export" || text.startsWith("memory export ")) {
      if (!this.enabled()) return "记忆未开启。";
      const cursor = text === "memory export" ? "" : text.slice(14);
      if (cursor && !/^[a-f0-9]{64}$/u.test(cursor)) return "无效导出游标。";
      const rows = this.accounts.database.prepare("SELECT memory_id AS id,subject,content,content_hash AS contentHash,category,status,revision,thread_id AS threadId,message_id AS messageId,created_at AS createdAtMs FROM channel_memories WHERE account=? AND memory_id>? AND status IN ('active','conflict') ORDER BY memory_id LIMIT 101").all(this.account, cursor);
      const page = rows.slice(0, 100);
      return JSON.stringify({ memories: this.verifiedRows(page), nextCursor: rows.length > 100 ? page.at(-1)!.id : null, note: "仅当前通道有效或冲突事实；分页期间发生修改应重新导出，不含原始聊天或已遗忘内容。" });
    }
    if (text.startsWith("memory source ")) {
      if (!this.enabled()) return "记忆未开启。";
      const row = this.accounts.database.prepare("SELECT memory_id AS id,subject,content,content_hash AS contentHash,category,status,revision,supersedes,valid_from AS validFromMs,valid_until AS validUntilMs,thread_id AS threadId,message_id AS messageId,created_at AS createdAtMs FROM channel_memories WHERE account=? AND memory_id=?").get(this.account, text.slice(14));
      const facts = row ? this.verifiedRows([row]) : [];
      return facts[0] ? JSON.stringify(facts[0]) : "记忆不存在或无法核实归属。";
    }
    if (text.startsWith("memory correct ")) return this.correct(text, source);
    if (text.startsWith("memory forget ")) {
      if (!this.enabled()) return "记忆未开启。";
      const parsed = /^memory forget ([a-f0-9]{64}) ([1-9]\d*)$/u.exec(text);
      return parsed ? forgetFact(this.accounts, this.provenance, this.account, parsed[1]!, Number(parsed[2]), source.nowMs) : "请使用 memory forget <记忆ID> <当前修订>。";
    }
    if (!text.startsWith("memory remember ")) return `未知记忆命令。\n${MEMORY_HELP}`;
    if (!this.enabled()) return "记忆未开启，请先发送 memory enable。";
    if (source.policy && !source.policy.enabled) return "未保存：该消息在记忆关闭期间接收。";
    const evidenceId = `wechat:${source.messageId}`;
    this.provenance.original({ id: evidenceId, threadId: source.threadId, messageId: source.messageId, kind: source.kind ?? "unknown" });
    if (!this.provenance.check(evidenceId, source.threadId).eligible) return "未保存：来源不是可核实的本通道用户原始陈述。";
    const content = text.slice("memory remember ".length).trim();
    if (!admissibleStatement(content)) {
      return "未保存：仅接受不含引用、附件、工具或凭据的本人明确陈述（300字以内）。";
    }
    const db = this.accounts.database;
    db.exec("BEGIN IMMEDIATE");
    try { storeFact(this.accounts, this.provenance, this.account, { content, threadId: source.threadId, messageId: source.messageId, createdAtMs: source.nowMs, category: /^我(?:决定|约定)/u.test(content) ? "decision" : "preference", evidenceType: "explicit" }); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    return "已记住本通道的明确陈述，可用 memory show 查看内容与来源。";
  }
  context(threadId: string, query?: string): MemoryContext {
    const result=this.recall(threadId,query);
    return result.selected.length?{[MEMORY_CONTEXT_KEY]:{kind:"untrusted",value:JSON.stringify({memories:result.selected.map(s=>s.memory)})}}:{};
  }
  allowsInteraction(threadId:string):boolean{return this.owned(threadId)&&!this.isPrivate(threadId);}
  recallWeights():RecallWeights{
    const row=this.accounts.database.prepare("SELECT payload FROM memory_recall_settings WHERE account=?").get(this.account);
    const w=row?JSON.parse(String(row.payload)):DEFAULT_RECALL_WEIGHTS;
    if(Object.keys(w).sort().join()!=="explicit,relevance,time"||Object.values(w).some(v=>!Number.isInteger(v)||Number(v)<0||Number(v)>5))throw Error("E_RECALL_SETTINGS");return {...w};
  }
  recallRevision():number{return Number(this.accounts.database.prepare("SELECT revision FROM memory_recall_settings WHERE account=?").get(this.account)?.revision??0);}
  setRecallWeights(revision:number,weights:unknown){
    if(this.recallRevision()!==revision)throw Error("召回配置修订已变化，请刷新后重试。");
    if(!weights||typeof weights!=="object"||Array.isArray(weights)||Object.keys(weights).sort().join()!=="explicit,relevance,time"||Object.values(weights).some(v=>!Number.isInteger(v)||Number(v)<0||Number(v)>5))throw Error("召回权重必须为0–5。");
    const result=this.accounts.database.prepare("INSERT INTO memory_recall_settings(account,payload,revision) VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET payload=excluded.payload,revision=excluded.revision WHERE memory_recall_settings.revision=?").run(this.account,JSON.stringify(weights),revision+1,revision);if(Number(result.changes)!==1)throw Error("召回配置修订已变化，请刷新后重试。");return {revision:revision+1,weights:this.recallWeights()};
  }
  recall(threadId:string,query?:string,requestId?:string,writeReceipt=true){
    const weights=this.recallWeights(),selected:ReturnType<typeof rankMemories>=[],now=this.now(),seen=new Set<string>();let budgetSkipped=0,duplicatesSkipped=0;
    if(this.allowsInteraction(threadId)&&this.enabled())for(const item of rankMemories(this.entries(query) as RecalledMemory[],query,weights,now)){
      if(selected.length>=12)break;
      const key=semanticKey(item.memory.content)+":"+semanticValue(item.memory.content);if(seen.has(key)){duplicatesSkipped++;continue;}
      if(Buffer.byteLength(JSON.stringify({memories:[...selected,item].map(x=>x.memory)}))>MEMORY_CONTEXT_BYTES){budgetSkipped++;continue;}selected.push(item);seen.add(key);
    }
    const result={threadId,enabled:this.enabled(),timeIntent:recallTimeIntent(query),weights,budgetSkipped,duplicatesSkipped,selected};
    if(writeReceipt&&this.allowsInteraction(threadId)){
      const id=requestId??createHash("sha256").update(JSON.stringify([threadId,query??"",this.snapshot().revision])).digest("hex");
      const safe={...result,selected:selected.map(x=>({id:x.memory.id,score:x.score,reasons:x.reasons}))};
      this.accounts.database.prepare("INSERT INTO memory_recall_receipts VALUES(?,?,?,?,?) ON CONFLICT(account,thread_id,request_id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at").run(this.account,threadId,id,JSON.stringify(safe),now);
      this.accounts.database.prepare("DELETE FROM memory_recall_receipts WHERE account=? AND rowid NOT IN (SELECT rowid FROM memory_recall_receipts WHERE account=? ORDER BY created_at DESC,rowid DESC LIMIT 64)").run(this.account,this.account);
    }return result;
  }
  explain(threadId:string){
    if(!this.allowsInteraction(threadId)||!this.enabled())return {selected:[],note:"本通道记忆未开启或当前会话不允许读取。"};
    const row=this.accounts.database.prepare("SELECT payload,created_at FROM memory_recall_receipts WHERE account=? AND thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(this.account,threadId);
    if(!row)return {selected:[],note:"当前会话尚无召回回执。"};
    const receipt=JSON.parse(String(row.payload));const visible=new Map(this.entries(receipt.timeIntent==="earliest"?"最早":undefined).map(x=>[x.id,x]));
    return {...receipt,createdAtMs:row.created_at,selected:(receipt.selected as Array<{id:string;score:number;reasons:string[]}>).flatMap(x=>{const m=visible.get(x.id);return m?[{...m,score:x.score,reasons:x.reasons}]:[]})};
  }
  recordTurn(source: MemorySource, turnId: string): void {
    if (!this.owned(source.threadId)) return;
    const policy = this.snapshot(), captured = source.policy ?? policy;
    const excluded = !policy.enabled || !captured.enabled || captured.unavailable || policy.revision !== captured.revision || this.isPrivate(source.threadId) || source.kind !== "channel-original";
    this.accounts.database.prepare("INSERT OR IGNORE INTO memory_inputs VALUES(?,?,?,?,?,?,?,?)").run(this.account, source.messageId, source.threadId, captured.revision, excluded ? 1 : 0, source.nowMs, !excluded && source.text ? createHash("sha256").update(source.text).digest("hex") : null, source.kind ?? "unknown");
    if (excluded) return;
    const id = `wechat:${source.messageId}`;
    this.provenance.original({ id, threadId: source.threadId, messageId: source.messageId, kind: source.kind ?? "unknown" });
    this.provenance.linkTurn(source.threadId, turnId, id);
    if (policy.autoEnabled && captured.autoEnabled && source.text) this.extraction?.enqueue({ id, threadId: source.threadId, messageId: source.messageId, turnId, text: source.text, revision: policy.revision, createdAtMs: source.nowMs });
  }
  recordReference(threadId: string, turnId: string, eventId: string): void {
    if (!this.enabled() || this.isPrivate(threadId)) return;
    const id = JSON.stringify(["reference", threadId, turnId, eventId]);
    this.provenance.reference({ id, threadId, messageId: eventId });
    this.provenance.linkTurn(threadId, turnId, id);
  }
  recordAssistant(threadId: string, turnId: string): void {
    if (!this.enabled() || this.isPrivate(threadId)) return;
    this.provenance.derive({ id: JSON.stringify(["assistant", threadId, turnId]), threadId, messageId: turnId, parents: this.provenance.turnSources(threadId, turnId) });
  }
  async tick(): Promise<void> { if (this.backfill) await this.backfill.tick(); await this.extraction?.tick(); }
  private correct(text: string, source: MemorySource): string {
    if (!this.enabled()) return "记忆未开启。";
    if (source.policy && !source.policy.enabled) return "未保存：该消息在记忆关闭期间接收。";
    const parsed = /^memory correct ([a-f0-9]{64}) ([1-9]\d*) (.+)$/u.exec(text);
    if (!parsed || !admissibleStatement(parsed[3]!)) return "未保存：请使用 memory correct <记忆ID> <当前修订> <本人明确陈述>。";
    this.provenance.original({ id: `wechat:${source.messageId}`, threadId: source.threadId, messageId: source.messageId, kind: source.kind ?? "unknown" });
    if (!this.provenance.check(`wechat:${source.messageId}`, source.threadId).eligible) return "未保存：来源不合格。";
    const db = this.accounts.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db.prepare("SELECT thread_id AS threadId,message_id AS messageId,status,revision,semantic_key AS semanticKey FROM channel_memories WHERE account=? AND memory_id=?").get(this.account, parsed[1]!);
      if (!old || !this.provenance.check(`wechat:${old.messageId}`, String(old.threadId)).eligible) { db.exec("ROLLBACK"); return "记忆不存在或无法核实归属。"; }
      if (Number(old.revision) !== Number(parsed[2]) || !["active", "conflict", "candidate"].includes(String(old.status))) { db.exec("ROLLBACK"); return "修订已变化或已取代，请重新查看后纠正。"; }
      if (db.prepare("SELECT 1 FROM channel_memories WHERE account=? AND message_id=?").get(this.account, source.messageId)) { db.exec("ROLLBACK"); return "该来源已使用，请通过新的明确消息纠正。"; }
      db.prepare("UPDATE channel_memories SET status='superseded',revision=revision+1,valid_until=? WHERE account=? AND (semantic_key=? OR semantic_key=?) AND status IN ('active','conflict','candidate')").run(source.nowMs, this.account, old.semanticKey!, semanticKey(parsed[3]!));
      storeFact(this.accounts, this.provenance, this.account, { content: parsed[3]!, category: "preference", threadId: source.threadId, messageId: source.messageId, createdAtMs: source.nowMs, evidenceType: "correction", supersedes: parsed[1]! });
      db.prepare("UPDATE memory_policies SET revision=revision+1 WHERE account=?").run(this.account);
      db.exec("COMMIT"); return "已纠正，旧证据保留并标为已取代；后台旧修订不能覆盖本次纠正。";
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
