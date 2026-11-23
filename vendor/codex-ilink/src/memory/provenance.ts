import type { AccountStore } from "../accounts/account-store.ts";

export type SourceKind = "channel-original" | "external-reference" | "mixed" | "unknown";
type Coordinate = { id: string; threadId: string; messageId: string };
type RecordRow = Coordinate & { kind: SourceKind; origin: "original" | "reference" | "derived"; parents: string };
type Verdict = { eligible: boolean; kind: SourceKind; reason: string };

/** Metadata only. Trusted ingress supplies categories; no model-facing write tool exists. */
export class MemoryProvenance {
  readonly accounts: AccountStore;
  readonly account: string;
  constructor(accounts: AccountStore, account: string) {
    this.accounts = accounts; this.account = account;
    accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_sources(
      account TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,
      kind TEXT NOT NULL,origin TEXT NOT NULL,parents TEXT NOT NULL,PRIMARY KEY(account,id)
    ) STRICT;`);
    accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_turn_sources(account TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(account,thread_id,turn_id,source_id)) STRICT;`);
    accounts.database.exec("CREATE INDEX IF NOT EXISTS memory_source_threads ON memory_sources(account,thread_id); CREATE TABLE IF NOT EXISTS memory_source_quarantine(account TEXT NOT NULL,thread_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(account,thread_id)) STRICT;");
  }
  private get(id: string): RecordRow | undefined {
    return this.accounts.database.prepare("SELECT id,thread_id AS threadId,message_id AS messageId,kind,origin,parents FROM memory_sources WHERE account=? AND id=?").get(this.account, id) as RecordRow | undefined;
  }
  private write(row: RecordRow): void {
    if (this.accounts.explicitOwner(row.threadId) !== this.account) throw Error("E_PROVENANCE_OWNERSHIP");
    const previous = this.get(row.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(row)) throw Error("E_PROVENANCE_COLLISION");
      return;
    }
    this.accounts.database.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?)").run(this.account, row.id, row.threadId, row.messageId, row.kind, row.origin, row.parents);
  }
  original(input: Coordinate & { kind: SourceKind }): void {
    if (!["channel-original", "external-reference", "mixed", "unknown"].includes(input.kind)) throw Error("E_PROVENANCE_KIND");
    this.write({ id: input.id, threadId: input.threadId, messageId: input.messageId, kind: input.kind, origin: "original", parents: "[]" });
  }
  reference(input: Coordinate): void { this.write({ ...input, kind: "external-reference", origin: "reference", parents: "[]" }); }
  derive(input: Coordinate & { parents: string[] }): void {
    if (input.parents.length > 32 || !input.parents.every(x => typeof x === "string" && x !== input.id)) throw Error("E_PROVENANCE_PARENTS");
    const kinds = input.parents.map(id => this.check(id, input.threadId).kind);
    const kind: SourceKind = !kinds.length || kinds.includes("unknown") ? "unknown"
      : kinds.includes("mixed") || new Set(kinds).size > 1 ? "mixed" : kinds[0]!;
    this.write({ id: input.id, threadId: input.threadId, messageId: input.messageId, kind, origin: "derived", parents: JSON.stringify(input.parents) });
  }
  check(id: string, threadId: string): Verdict {
    const invalid = (reason: string): Verdict => ({ eligible: false, kind: "unknown", reason });
    const row = this.get(id);
    if (!row || row.threadId !== threadId) return invalid("missing-or-foreign-source");
    if (this.accounts.explicitOwner(threadId) !== this.account) { this.quarantineThread(threadId); return invalid("unverified-ownership"); }
    if (this.quarantined(threadId)) return invalid("quarantined-ownership");
    // Revalidate the complete derivation chain at the boundary. Never trust a cached category alone.
    const pending = [row], seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current.id)) continue;
      if (seen.size >= 256) return invalid("source-budget");
      seen.add(current.id);
      if (!["channel-original", "external-reference", "mixed", "unknown"].includes(current.kind) || !["original", "reference", "derived"].includes(current.origin)) return invalid("invalid-source");
      if (this.accounts.explicitOwner(current.threadId) !== this.account) { this.quarantineThread(current.threadId); return invalid("ownership-changed"); }
      if (this.quarantined(current.threadId)) return invalid("quarantined-ownership");
      let parents: unknown;
      try { parents = JSON.parse(current.parents); } catch { return invalid("invalid-source"); }
      if (!Array.isArray(parents) || parents.length > 32) return invalid("invalid-source");
      if (current.origin !== "derived" && parents.length !== 0) return invalid("invalid-source");
      for (const parent of parents) {
        if (typeof parent !== "string") return invalid("invalid-source");
        const found = this.get(parent); if (!found) return invalid("missing-parent");
        pending.push(found);
      }
    }
    return { eligible: row.kind === "channel-original" && row.origin === "original", kind: row.kind,
      reason: row.origin === "derived" ? "derived-reference" : row.kind === "channel-original" && row.origin === "original" ? "original-user" : "reference-or-unknown" };
  }
  quarantineThread(threadId: string): void {
    if (!this.accounts.database.prepare("SELECT 1 FROM memory_sources WHERE account=? AND thread_id=?").get(this.account, threadId)) return;
    this.accounts.database.prepare("INSERT OR IGNORE INTO memory_source_quarantine VALUES(?,?,'ownership-changed')").run(this.account, threadId);
  }
  private quarantined(threadId: string): boolean { return !!this.accounts.database.prepare("SELECT 1 FROM memory_source_quarantine WHERE account=? AND thread_id=?").get(this.account, threadId); }
  reconcileOwnership(): void {
    const rows = this.accounts.database.prepare("SELECT DISTINCT s.thread_id AS id FROM memory_sources s LEFT JOIN thread_accounts t ON t.thread_id=s.thread_id WHERE s.account=? AND (t.account_name IS NULL OR t.account_name!=?)").all(this.account, this.account);
    for (const row of rows) this.quarantineThread(String(row.id));
  }
  linkTurn(threadId: string, turnId: string, sourceId: string): void {
    if (this.accounts.explicitOwner(threadId) !== this.account || !this.get(sourceId)) throw Error("E_PROVENANCE_OWNERSHIP");
    this.accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_turn_sources(account TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(account,thread_id,turn_id,source_id)) STRICT;`);
    this.accounts.database.prepare("INSERT OR IGNORE INTO memory_turn_sources VALUES(?,?,?,?)").run(this.account, threadId, turnId, sourceId);
  }
  turnSources(threadId: string, turnId: string): string[] {
    this.accounts.database.exec(`CREATE TABLE IF NOT EXISTS memory_turn_sources(account TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(account,thread_id,turn_id,source_id)) STRICT;`);
    return (this.accounts.database.prepare("SELECT source_id AS id FROM memory_turn_sources WHERE account=? AND thread_id=? AND turn_id=? ORDER BY source_id LIMIT 33").all(this.account, threadId, turnId) as Array<{ id: string }>).map(r => r.id);
  }
}
