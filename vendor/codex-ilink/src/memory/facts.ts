import { createHash } from "node:crypto";
import type { AccountStore } from "../accounts/account-store.ts";
import type { MemoryProvenance } from "./provenance.ts";
import { excludedAutomaticFact } from "./forget.ts";
import { semanticKey, semanticValue, semanticFamily } from "./semantics.ts";

export function memoryId(account: string, messageId: string): string { return createHash("sha256").update(JSON.stringify([account, messageId])).digest("hex"); }
/** Caller holds an immediate transaction. Source and namespace are always rechecked. */
export function storeFact(accounts: AccountStore, provenance: MemoryProvenance, account: string, input: {
  content: string; category: string; threadId: string; messageId: string; createdAtMs: number;
  evidenceType: "explicit" | "extracted" | "correction"; supersedes?: string;
}): void {
  if (!provenance.check(`wechat:${input.messageId}`, input.threadId).eligible) throw Error("E_MEMORY_SOURCE");
  provenance.reconcileOwnership();
  if (input.evidenceType === "extracted" && excludedAutomaticFact(accounts, account, input.content, `wechat:${input.messageId}`)) return;
  const db = accounts.database, key = semanticKey(input.content);
  if (db.prepare("SELECT 1 FROM channel_memories WHERE account=? AND message_id=?").get(account, input.messageId)) return;
  const previous = db.prepare("SELECT content,evidence_type,thread_id AS threadId,message_id AS messageId FROM channel_memories WHERE account=? AND semantic_key=? AND status IN ('active','conflict')").all(account, key).filter(row => provenance.check(`wechat:${row.messageId}`, String(row.threadId)).eligible);
  const incompatible = previous.filter(r => semanticValue(String(r.content)) !== semanticValue(input.content));
  let status = "active";
  const corrections = input.evidenceType === "extracted" ? db.prepare("SELECT content,thread_id AS threadId,message_id AS messageId FROM channel_memories WHERE account=? AND evidence_type='correction' AND status='active'").all(account).filter(row => provenance.check(`wechat:${row.messageId}`, String(row.threadId)).eligible) : [];
  const family = semanticFamily(input.content);
  if (corrections.some(row => {
    const content = String(row.content), other = semanticFamily(content);
    return (family === "unknown" || other === "unknown" || other === family) && (semanticKey(content) !== key || semanticValue(content) !== semanticValue(input.content));
  })) status = "candidate";
  else if (incompatible.length && input.evidenceType !== "correction") {
    if (incompatible.some(r => r.evidence_type === "correction") && input.evidenceType === "extracted") status = "candidate";
    else {
      status = "conflict";
      db.prepare("UPDATE channel_memories SET status='conflict',revision=revision+1 WHERE account=? AND semantic_key=? AND status='active'").run(account, key);
    }
  }
  db.prepare(`INSERT INTO channel_memories(account,subject,content,thread_id,message_id,created_at,category,status,memory_id,revision,semantic_key,evidence_type,supersedes,valid_from,content_hash)
    VALUES(?,'user',?,?,?,?,?,?,?,1,?,?,?,?,?)`).run(account, input.content, input.threadId, input.messageId, input.createdAtMs, input.category, status, memoryId(account, input.messageId), key, input.evidenceType, input.supersedes ?? null, input.createdAtMs, createHash("sha256").update(input.content).digest("hex"));
}
