import { createHash, randomBytes } from "node:crypto";
import type { AccountStore } from "../accounts/account-store.ts";
import type { MemoryProvenance } from "./provenance.ts";
import type { MemoryPolicySnapshot } from "./channel-memory.ts";

export interface MemoryHistoryReader { read(threadId: string, cursor?: string): Promise<{ data: unknown[]; nextCursor: string | null }> }
export function initializeBackfill(accounts: AccountStore): void {
  accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_backfill_previews(account TEXT PRIMARY KEY,token_hash TEXT NOT NULL,revision INTEGER NOT NULL,expires INTEGER NOT NULL,threads TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS memory_backfill_jobs(account TEXT NOT NULL,thread_id TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,cursor TEXT,pages INTEGER NOT NULL DEFAULT 0,limit_at INTEGER NOT NULL DEFAULT 10,scanned INTEGER NOT NULL DEFAULT 0,enqueued INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,seen TEXT NOT NULL DEFAULT '[]',attempts INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(account,thread_id)) STRICT;`);
  if (!accounts.database.prepare("PRAGMA table_info(memory_backfill_jobs)").all().some(c => c.name === "resume_status")) accounts.database.exec("ALTER TABLE memory_backfill_jobs ADD COLUMN resume_status TEXT");
  for (const table of ["memory_backfill_jobs", "memory_backfill_previews"]) if (!accounts.database.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === "source_limit")) accounts.database.exec(`ALTER TABLE ${table} ADD COLUMN source_limit INTEGER NOT NULL DEFAULT 0`);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Job = { threadId: string; revision: number; cursor: string | null; pages: number; limitAt: number; seen: string; attempts: number; sourceLimit: number };

/** Finite, explicitly confirmed scans. Unknown historical provenance is skipped, never inferred. */
export class MemoryBackfill {
  readonly options: {
    accounts: AccountStore; account: string; provenance: MemoryProvenance; history: MemoryHistoryReader;
    policy: () => MemoryPolicySnapshot; allowedThread: (id: string) => boolean;
    mayBackfill: (thread: string, message: string, text: string) => boolean;
    enqueue: (input: { id: string; threadId: string; messageId: string; turnId: string; text: string; createdAtMs: number; revision: number }) => boolean;
    now: () => number;
  };
  #running: Promise<void> | undefined;
  constructor(options: MemoryBackfill["options"]) {
    this.options = options; initializeBackfill(options.accounts);
    options.accounts.database.prepare("UPDATE memory_backfill_jobs SET status='pending',error='read-interrupted' WHERE account=? AND status='reading'").run(options.account);
  }
  command(text: string): string {
    const { accounts, account, policy, now } = this.options, db = accounts.database, p = policy();
    if (!p.enabled) return "记忆未开启，回填不可用。";
    if (text === "memory backfill status") return JSON.stringify({ jobs: db.prepare("SELECT thread_id AS threadId,status,cursor,pages,limit_at AS pageLimit,scanned,enqueued,skipped,error FROM memory_backfill_jobs WHERE account=? ORDER BY thread_id").all(account), note: "complete仅表示本次历史分页遍历完成，提炼状态另看memory auto status。" });
    if (/^memory backfill preview(?: |$)/u.test(text)) {
      const selected = text.slice("memory backfill preview".length).trim();
      const rows = db.prepare("SELECT thread_id AS threadId FROM thread_accounts WHERE account_name=? ORDER BY thread_id LIMIT 21").all(account) as Array<{ threadId: string }>;
      const ids = selected ? [selected] : rows.slice(0, 20).map(r => r.threadId);
      if (selected && !this.options.allowedThread(selected)) return "会话不属于本通道或为无记忆临时会话，未读取历史。";
      const threads = ids.filter(id => this.options.allowedThread(id)).map(threadId => ({ threadId, verifiedMessages: Number(db.prepare("SELECT COUNT(*) AS n FROM memory_inputs WHERE account=? AND thread_id=? AND excluded=0").get(account, threadId)!.n) }));
      const code = randomBytes(6).toString("hex").toUpperCase();
      const sourceLimit = Number(db.prepare("SELECT MAX(rowid) AS n FROM memory_inputs WHERE account=?").get(account)!.n ?? 0);
      db.prepare("INSERT INTO memory_backfill_previews(account,token_hash,revision,expires,threads,source_limit) VALUES(?,?,?,?,?,?) ON CONFLICT(account) DO UPDATE SET token_hash=excluded.token_hash,revision=excluded.revision,expires=excluded.expires,threads=excluded.threads,source_limit=excluded.source_limit").run(account, hash(code), p.revision, now() + 120000, JSON.stringify(threads.map(t => t.threadId)), sourceLimit);
      return JSON.stringify({ threads, confirmationCode: code, moreThreads: !selected && rows.length > 20, pagesPerThread: 10, turnsPerPage: 10, expiresInSeconds: 120, historyRead: false, note: "包括范围内归档会话。完整性尚未核实；缺少原始来源、关闭期间、临时会话和已忘内容跳过。确认后所选合格片段会进入已配置的远端提炼请求，有模型开销。" });
    }
    const start = /^memory backfill start ([A-F0-9]{12})$/u.exec(text);
    if (start) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const preview = db.prepare("SELECT token_hash,revision,expires,threads,source_limit FROM memory_backfill_previews WHERE account=?").get(account);
        if (!preview || preview.token_hash !== hash(start[1]!) || Number(preview.expires) <= now() || Number(preview.revision) !== p.revision) { db.exec("ROLLBACK"); return "确认已失效，请重新预览。"; }
        const ids = JSON.parse(String(preview.threads)) as string[];
        if (!ids.every(id => this.options.allowedThread(id))) { db.exec("ROLLBACK"); return "会话归属或排除策略变化，请重新预览。"; }
        for (const id of ids) db.prepare("INSERT INTO memory_backfill_jobs(account,thread_id,revision,status,source_limit) VALUES(?,?,?,'pending',?) ON CONFLICT(account,thread_id) DO UPDATE SET revision=excluded.revision,status='pending',cursor=NULL,pages=0,limit_at=10,scanned=0,enqueued=0,skipped=0,seen='[]',attempts=0,due_at=0,error=NULL,source_limit=excluded.source_limit").run(account, id, p.revision, preview.source_limit!);
        db.prepare("DELETE FROM memory_backfill_previews WHERE account=?").run(account);
        db.exec("COMMIT"); return `已开始有限回填：${ids.length} 个会话，每会话最多10页，不中断前台任务。`;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (text === "memory backfill pause") { db.prepare("UPDATE memory_backfill_jobs SET resume_status=status,status='paused' WHERE account=? AND status IN ('pending','reading','complete','limited')").run(account); return "已暂停回填和后续回填提炼调用；已发出的模型调用可完成，前台任务继续。"; }
    if (text === "memory backfill cancel") {
      db.prepare("UPDATE memory_backfill_jobs SET status='cancelled' WHERE account=? AND status NOT IN ('complete','quarantined')").run(account);
      db.prepare("UPDATE memory_extraction_jobs SET status='invalidated',body=NULL,error='backfill-cancelled' WHERE account=? AND producer='backfill' AND status IN ('pending','running','unknown')").run(account);
      return "已取消未确认回填，不删除已有事实或原始对话。";
    }
    if (text === "memory backfill resume") {
      const result = db.prepare("UPDATE memory_backfill_jobs SET status=CASE WHEN resume_status='complete' THEN 'complete' ELSE 'pending' END,resume_status=NULL,limit_at=pages+10,attempts=0,due_at=0,error=NULL WHERE account=? AND revision=? AND status IN ('paused','limited','failed')").run(account, p.revision);
      return `已恢复 ${result.changes} 个作业，每会话增加至多10页预算；策略修订不匹配时须重新预览。`;
    }
    return "回填命令：memory backfill preview [会话ID] / start <确认码> / status / pause / resume / cancel。";
  }
  tick(): Promise<void> { if (!this.#running) this.#running = this.runOne().finally(() => { this.#running = undefined; }); return this.#running; }
  private async runOne(): Promise<void> {
    const { accounts, account, policy, now } = this.options, db = accounts.database;
    const job = db.prepare("SELECT thread_id AS threadId,revision,cursor,pages,limit_at AS limitAt,seen,attempts,source_limit AS sourceLimit FROM memory_backfill_jobs WHERE account=? AND status='pending' AND due_at<=? ORDER BY thread_id LIMIT 1").get(account, now()) as Job | undefined;
    if (!job) return;
    if (!this.options.allowedThread(job.threadId)) { if (accounts.explicitOwner(job.threadId) !== account) this.options.provenance.quarantineThread(job.threadId); db.prepare("UPDATE memory_backfill_jobs SET status='quarantined',error='ownership-or-private-changed' WHERE account=? AND thread_id=?").run(account, job.threadId); return; }
    if (!policy().enabled || policy().revision !== job.revision) { db.prepare("UPDATE memory_backfill_jobs SET status='paused',error='policy-changed' WHERE account=? AND thread_id=?").run(account, job.threadId); return; }
    if (!db.prepare("UPDATE memory_backfill_jobs SET status='reading' WHERE account=? AND thread_id=? AND status='pending'").run(account, job.threadId).changes) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const page = await Promise.race([this.options.history.read(job.threadId, job.cursor ?? undefined), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("history-timeout")), 10000); })]);
      if (!Array.isArray(page.data) || page.data.length > 10 || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor.length > 1000))) throw Error("invalid-page");
      const seen = JSON.parse(job.seen) as string[];
      if (seen.length >= 1000 || (page.nextCursor !== null && seen.includes(page.nextCursor))) throw Error("invalid-cursor");
      db.exec("BEGIN IMMEDIATE");
      try {
        const live = db.prepare("SELECT status,revision FROM memory_backfill_jobs WHERE account=? AND thread_id=?").get(account, job.threadId);
        if (live?.status !== "reading" || live.revision !== job.revision) { db.exec("ROLLBACK"); return; }
        if (!this.options.allowedThread(job.threadId) || policy().revision !== job.revision || !policy().enabled) {
          if (accounts.explicitOwner(job.threadId) !== account) this.options.provenance.quarantineThread(job.threadId);
          db.prepare("UPDATE memory_backfill_jobs SET status='quarantined',error='boundary-changed' WHERE account=? AND thread_id=?").run(account, job.threadId); db.exec("COMMIT"); return;
        }
        let enqueued = 0, skipped = 0;
        for (const turn of page.data) {
          const evidence = this.evidence(job.threadId, turn, job.sourceLimit);
          if (evidence && this.options.enqueue({ ...evidence, revision: job.revision })) enqueued++; else skipped++;
        }
        const pages = job.pages + 1;
        db.prepare("UPDATE memory_backfill_jobs SET status=?,cursor=?,pages=?,scanned=scanned+?,enqueued=enqueued+?,skipped=skipped+?,seen=?,attempts=0,error=NULL WHERE account=? AND thread_id=?")
          .run(page.nextCursor === null ? "complete" : pages >= job.limitAt ? "limited" : "pending", page.nextCursor, pages, page.data.length, enqueued, skipped, JSON.stringify(page.nextCursor === null ? seen : [...seen, page.nextCursor]), account, job.threadId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch {
      db.prepare("UPDATE memory_backfill_jobs SET status=?,attempts=attempts+1,due_at=?,error='history-unavailable-or-incomplete' WHERE account=? AND thread_id=? AND status='reading'").run(job.attempts + 1 >= 3 ? "failed" : "pending", now() + 60000 * 2 ** job.attempts, account, job.threadId);
    } finally { if (timer) clearTimeout(timer); }
  }
  private evidence(threadId: string, raw: unknown, sourceLimit: number): { id: string; threadId: string; messageId: string; turnId: string; text: string; createdAtMs: number } | null {
    if (!raw || typeof raw !== "object") return null;
    const turn = raw as Record<string, unknown>;
    if (typeof turn.id !== "string" || !["completed", "failed", "interrupted"].includes(String(turn.status)) || !Array.isArray(turn.items)) return null;
    const users = turn.items.filter(item => item && typeof item === "object" && item.type === "userMessage") as Array<{ content?: unknown }>;
    if (users.length !== 1 || !Array.isArray(users[0]!.content)) return null;
    const content = users[0]!.content as Array<{ type?: unknown; text?: unknown }>;
    if (!content.length || content.some(item => item.type !== "text" || typeof item.text !== "string")) return null;
    const text = content.map(item => item.text).join("");
    const { provenance, accounts, account } = this.options;
    const sources = provenance.turnSources(threadId, turn.id).filter(id => provenance.check(id, threadId).eligible);
    if (sources.length !== 1 || !sources[0]!.startsWith("wechat:")) return null;
    const id = sources[0]!, messageId = id.slice(7);
    if (!this.options.mayBackfill(threadId, messageId, text)) return null;
    const input = accounts.database.prepare("SELECT captured_at AS at FROM memory_inputs WHERE account=? AND thread_id=? AND message_id=? AND excluded=0 AND rowid<=?").get(account, threadId, messageId, sourceLimit);
    return input ? { id, threadId, messageId, turnId: turn.id, text, createdAtMs: Number(input.at) } : null;
  }
}
