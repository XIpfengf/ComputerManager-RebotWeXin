import type { AccountStore } from "../accounts/account-store.ts";
import type { MemoryProvenance } from "./provenance.ts";
import { storeFact } from "./facts.ts";
import { excludedAutomaticFact } from "./forget.ts";
import { initializeBackfill } from "./backfill.ts";
import { createHash } from "node:crypto";

export type ExtractionEvidence = { id: string; text: string };
export interface MemoryExtractor {
  extract(input: { evidence: ExtractionEvidence[]; signal: AbortSignal; maxOutputBytes: number }): Promise<unknown>;
  metrics?(): Record<string, unknown>;
}
export type ExtractedFact = { sourceId: string; subject: "user"; category: "preference" | "decision" | "event"; content: string };
type Job = { id: string; threadId: string; messageId: string; turnId: string; text: string; createdAtMs: number; revision: number; attempts: number; producer: "auto" | "backfill" };
export const EXTRACTION_INPUT_BYTES = 4096;
export const EXTRACTION_OUTPUT_BYTES = 4096;
export class ExtractionFailure extends Error {
  readonly outcome: "failed" | "unknown";
  constructor(outcome: "failed" | "unknown") { super(`E_EXTRACTION_${outcome.toUpperCase()}`); this.outcome = outcome; }
}

/** Conservative first release: verbatim stable self-statements, never inferred personality. */
export function admissibleStatement(text: string): boolean {
  return text.length <= 300 && /^我(?:最(?:喜欢|不喜欢|爱)|喜欢|不喜欢|偏好|希望|决定|约定|的)/u.test(text)
    && !/[\r\n<>`"“”「」『』]|引用|转述|复制|导入|另一个用户|附件|工具|网页|外部|他说|她说|密码|令牌|密钥|token|api[_ -]?key|\bBearer\s+\S+|\bsk-[a-z0-9_-]{8,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|今天.*累|疲惫|玩笑|可能|猜测|暂时|哈哈/iu.test(text);
}

/** Durable, one-source jobs. Claim and commit are atomic; network work holds no transaction. */
export class MemoryExtractionQueue {
  readonly accounts: AccountStore;
  readonly account: string;
  readonly provenance: MemoryProvenance;
  readonly extractor: MemoryExtractor;
  readonly now: () => number;
  readonly timeoutMs: number;
  #running: Promise<void> | undefined;
  #controller: AbortController | undefined;
  constructor(options: { accounts: AccountStore; account: string; provenance: MemoryProvenance; extractor: MemoryExtractor; now?: () => number; timeoutMs?: number }) {
    this.accounts = options.accounts; this.account = options.account; this.provenance = options.provenance; this.extractor = options.extractor; this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000) throw Error("E_EXTRACTION_TIMEOUT_CONFIGURATION");
    this.accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_extraction_jobs(
      account TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,turn_id TEXT NOT NULL,
      body TEXT,created_at INTEGER NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(account,id)
    ) STRICT;`);
    this.accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_extraction_usage(account TEXT NOT NULL,day INTEGER NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(account,day)) STRICT;`);
    if (!this.accounts.database.prepare("PRAGMA table_info(memory_extraction_jobs)").all().some(c => c.name === "producer")) this.accounts.database.exec("ALTER TABLE memory_extraction_jobs ADD COLUMN producer TEXT NOT NULL DEFAULT 'auto'");
    initializeBackfill(this.accounts);
    // A restarted in-flight call is not safe to bill again. Explicit reconciliation is required.
    this.accounts.database.prepare("UPDATE memory_extraction_jobs SET status='unknown',error='interrupted-call' WHERE account=? AND status='running'").run(this.account);
  }
  enqueue(job: Omit<Job, "attempts" | "producer">, producer: "auto" | "backfill" = "auto"): boolean {
    if (excludedAutomaticFact(this.accounts, this.account, job.text, job.id)) return false;
    if (!admissibleStatement(job.text) || Buffer.byteLength(job.text) > EXTRACTION_INPUT_BYTES || !this.provenance.check(job.id, job.threadId).eligible) return false;
    return !!this.accounts.database.prepare("INSERT OR IGNORE INTO memory_extraction_jobs(account,id,thread_id,message_id,turn_id,body,created_at,revision,status,producer) VALUES(?,?,?,?,?,?,?,?, 'pending',?)")
      .run(this.account, job.id, job.threadId, job.messageId, job.turnId, job.text, job.createdAtMs, job.revision, producer).changes;
  }
  status(): Record<string, unknown> {
    const counts = this.accounts.database.prepare("SELECT status,COUNT(*) AS count FROM memory_extraction_jobs WHERE account=? GROUP BY status").all(this.account);
    const usage = this.accounts.database.prepare("SELECT calls FROM memory_extraction_usage WHERE account=? AND day=?").get(this.account, Math.floor(this.now() / 86400000));
    return { jobs: counts, callsToday: usage?.calls ?? 0, inputBudgetBytes: EXTRACTION_INPUT_BYTES, outputBudgetBytes: EXTRACTION_OUTPUT_BYTES, maxAttempts: 3, maxCallsPerUtcDay: 50, timeoutMs: this.timeoutMs, providerUsageSinceStart: this.extractor.metrics?.() ?? null };
  }
  cancel(): void {
    this.accounts.database.prepare("UPDATE memory_extraction_jobs SET status='invalidated',body=NULL,error='user-cancelled' WHERE account=? AND status IN ('pending','running','unknown')").run(this.account);
    this.#controller?.abort();
  }
  reconcile(): string {
    // store:false does not provide a retrievable provider result. Never invent remote success.
    const rows = this.accounts.database.prepare("SELECT id,message_id FROM memory_extraction_jobs WHERE account=? AND status='unknown' LIMIT 100").all(this.account);
    let confirmed = 0;
    for (const row of rows) {
      if (this.accounts.database.prepare("SELECT 1 FROM channel_memories WHERE account=? AND message_id=?").get(this.account, row.message_id!)) {
        this.accounts.database.prepare("UPDATE memory_extraction_jobs SET status='done',body=NULL,error=NULL WHERE account=? AND id=? AND status='unknown'").run(this.account, row.id!); confirmed++;
      }
    }
    return `本地已核实 ${confirmed} 项；仍未知 ${rows.length - confirmed} 项。无可检索的远端结果时不重发；可取消未知作业，或用新的显式记忆操作确认事实。`;
  }
  tick(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.runOne().finally(() => { this.#running = undefined; });
    return this.#running;
  }
  private async runOne(): Promise<void> {
    const db = this.accounts.database;
    const job = db.prepare(`SELECT id,thread_id AS threadId,message_id AS messageId,turn_id AS turnId,body AS text,created_at AS createdAtMs,revision,attempts,producer FROM memory_extraction_jobs j WHERE account=? AND status='pending' AND due_at<=?
      AND (producer='auto' OR EXISTS(SELECT 1 FROM memory_backfill_jobs b WHERE b.account=j.account AND b.thread_id=j.thread_id AND b.status IN ('pending','reading','complete','limited')))
      ORDER BY created_at,id LIMIT 1`).get(this.account, this.now()) as Job | undefined;
    if (!job) return;
    const policy = () => db.prepare("SELECT enabled,auto_enabled,revision FROM memory_policies WHERE account=?").get(this.account);
    const valid = () => {
      const p = policy();
      const backfill = job.producer === "backfill" ? db.prepare("SELECT status FROM memory_backfill_jobs WHERE account=? AND thread_id=?").get(this.account, job.threadId) : undefined;
      const evidence = db.prepare("SELECT excluded,text_hash FROM memory_inputs WHERE account=? AND thread_id=? AND message_id=?").get(this.account, job.threadId, job.messageId);
      const privateThread = db.prepare("SELECT 1 FROM memory_private_threads WHERE account=? AND thread_id=?").get(this.account, job.threadId);
      return typeof job.text === "string" && admissibleStatement(job.text) && job.id === `wechat:${job.messageId}` && evidence?.excluded === 0 && evidence.text_hash === createHash("sha256").update(job.text).digest("hex") && !privateThread
        && p?.enabled === 1 && (job.producer === "backfill" ? backfill && !["cancelled", "quarantined"].includes(String(backfill.status)) : p.auto_enabled === 1) && p.revision === job.revision && this.provenance.check(job.id, job.threadId).eligible;
    };
    if (!valid()) { db.prepare("UPDATE memory_extraction_jobs SET status='invalidated',body=NULL,error='source-or-policy-changed' WHERE account=? AND id=? AND status='pending'").run(this.account, job.id); return; }
    const day = Math.floor(this.now() / 86400000);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO memory_extraction_usage VALUES(?,?,0)").run(this.account, day);
      const usage = db.prepare("SELECT calls FROM memory_extraction_usage WHERE account=? AND day=?").get(this.account, day)!;
      if (Number(usage.calls) >= 50 || !db.prepare("UPDATE memory_extraction_jobs SET status='running',attempts=attempts+1 WHERE account=? AND id=? AND status='pending'").run(this.account, job.id).changes) { db.exec("ROLLBACK"); return; }
      db.prepare("UPDATE memory_extraction_usage SET calls=calls+1 WHERE account=? AND day=?").run(this.account, day);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const controller = new AbortController();
    this.#controller = controller;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.extractor.extract({ evidence: [{ id: job.id, text: job.text }], signal: controller.signal, maxOutputBytes: EXTRACTION_OUTPUT_BYTES }),
        new Promise<never>((_, reject) => { controller.signal.addEventListener("abort", () => reject(new ExtractionFailure("unknown")), { once: true }); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ExtractionFailure("unknown")); }, this.timeoutMs); }),
      ]);
      if (controller.signal.aborted) throw new ExtractionFailure("unknown");
      if (Buffer.byteLength(JSON.stringify(result) ?? "") > EXTRACTION_OUTPUT_BYTES) throw new ExtractionFailure("failed");
      const facts = validateExtraction(result, job);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!valid() || db.prepare("SELECT status FROM memory_extraction_jobs WHERE account=? AND id=?").get(this.account, job.id)?.status !== "running") {
          db.prepare("UPDATE memory_extraction_jobs SET status='invalidated',body=NULL,error='source-or-policy-changed' WHERE account=? AND id=?").run(this.account, job.id);
        } else {
          for (const fact of facts) storeFact(this.accounts, this.provenance, this.account, { content: fact.content, category: fact.category, threadId: job.threadId, messageId: job.messageId, createdAtMs: job.createdAtMs, evidenceType: "extracted" });
          db.prepare("UPDATE memory_extraction_jobs SET status='done',body=NULL,error=NULL WHERE account=? AND id=?").run(this.account, job.id);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      const outcome = error instanceof ExtractionFailure ? error.outcome : "unknown";
      const status = outcome === "unknown" ? "unknown" : job.attempts + 1 >= 3 ? "failed" : "pending";
      db.prepare("UPDATE memory_extraction_jobs SET status=?,error=?,due_at=? WHERE account=? AND id=? AND status='running'")
        .run(status, outcome === "unknown" ? "unknown-call-outcome" : "invalid-or-rejected-result", this.now() + 60000 * 2 ** job.attempts, this.account, job.id);
    } finally { if (timer) clearTimeout(timer); this.#controller = undefined; }
  }
}

function validateExtraction(result: unknown, job: Job): ExtractedFact[] {
  const fail = () => { throw new ExtractionFailure("failed"); };
  if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).join() !== "facts") return fail();
  const facts = (result as { facts: unknown }).facts;
  if (!Array.isArray(facts) || facts.length > 1) return fail();
  for (const fact of facts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact) || Object.keys(fact).sort().join() !== "category,content,sourceId,subject") return fail();
    if (fact.sourceId !== job.id || fact.subject !== "user" || !["preference", "decision", "event"].includes(fact.category) || typeof fact.content !== "string" || fact.content !== job.text || !admissibleStatement(fact.content)) return fail();
  }
  return facts as ExtractedFact[];
}
