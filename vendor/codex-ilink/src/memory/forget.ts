import { createHash } from "node:crypto";
import type { AccountStore } from "../accounts/account-store.ts";
import type { MemoryProvenance } from "./provenance.ts";
import { semanticKey, semanticFamily } from "./semantics.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function initializeForgetting(accounts: AccountStore): void {
  accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_tombstones(account TEXT NOT NULL,source_hash TEXT NOT NULL,key_hash TEXT NOT NULL,family TEXT NOT NULL,forgotten_at INTEGER NOT NULL,PRIMARY KEY(account,source_hash)) STRICT;`);
}
export function excludedAutomaticFact(accounts: AccountStore, account: string, text: string, sourceId: string): boolean {
  const rows = accounts.database.prepare("SELECT source_hash,key_hash,family FROM memory_tombstones WHERE account=?").all(account);
  const family = semanticFamily(text);
  // When semantic independence cannot be proved, require a new explicit operation.
  return rows.some(row => row.source_hash === hash(sourceId) || row.key_hash === hash(semanticKey(text)) || row.family === family || row.family === "unknown" || family === "unknown");
}

export function forgetFact(accounts: AccountStore, provenance: MemoryProvenance, account: string, id: string, revision: number, nowMs: number): string {
  const db = accounts.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    const old = db.prepare("SELECT message_id,thread_id,status,revision FROM channel_memories WHERE account=? AND memory_id=?").get(account, id);
    if (!old || !provenance.check(`wechat:${old.message_id}`, String(old.thread_id)).eligible) { db.exec("ROLLBACK"); return "记忆不存在或无法核实归属。"; }
    if (old.status === "forgotten" || Number(old.revision) !== revision) { db.exec("ROLLBACK"); return "修订已变化或已经遗忘，请重新查看。"; }
    const rows = db.prepare("SELECT memory_id,message_id,semantic_key,content,supersedes FROM channel_memories WHERE account=? LIMIT 10000").all(account);
    if (rows.length >= 10000) { db.exec("ROLLBACK"); return "关联范围超过本次安全预算，未执行遗忘。"; }
    const ids = new Set([id]), keys = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const rowId = String(row.memory_id), key = String(row.semantic_key);
        if (ids.has(rowId)) {
          if (key && !keys.has(key)) { keys.add(key); changed = true; }
          if (typeof row.supersedes === "string" && !ids.has(row.supersedes)) { ids.add(row.supersedes); changed = true; }
        } else if ((key && keys.has(key)) || (typeof row.supersedes === "string" && ids.has(row.supersedes))) { ids.add(rowId); changed = true; }
      }
    }
    for (const row of rows.filter(row => ids.has(String(row.memory_id)))) {
      db.prepare("INSERT OR IGNORE INTO memory_tombstones VALUES(?,?,?,?,?)").run(account, hash(`wechat:${row.message_id}`), hash(String(row.semantic_key)), semanticFamily(String(row.content)), nowMs);
      db.prepare("UPDATE channel_memories SET content='',content_hash=?,semantic_key='',status='forgotten',revision=revision+1,valid_until=? WHERE account=? AND memory_id=?").run(hash(""), nowMs, account, row.memory_id!);
    }
    db.prepare("UPDATE memory_policies SET revision=revision+1 WHERE account=?").run(account);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_extraction_jobs'").get()) db.prepare("UPDATE memory_extraction_jobs SET status='invalidated',body=NULL,error='forget-barrier' WHERE account=? AND status IN ('pending','running','unknown')").run(account);
    db.exec("COMMIT");
    return "已遗忘该记忆及相关派生。原始对话和已进入旧模型上下文的内容未删除；可新建无记忆会话。相近或无法核实独立性的自动候选将跳过，需要新的显式操作才能重新记入。";
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
