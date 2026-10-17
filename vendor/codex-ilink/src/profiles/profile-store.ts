import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertAccountName } from "../accounts/account-store.ts";
import { COMPILER_VERSION, defaultProfile, PROFILE_MAX_BYTES, validateProfile, type ChannelProfile } from "./profile.ts";
export const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const serialize = (p: ChannelProfile): string => `${JSON.stringify(p, null, 2)}\n`;
export type ThreadProfile = { account: string; threadId: string; profile: ChannelProfile; instructions: string; compilerVersion: number; instructionHash: string; model: string; effort: string | null; cwd: string };
type Revision = { payload: string; hash: string; revision: number };
type Intent = { id: string; account: string; oldHash: string; payload: string; hash: string; previous: string };
/** One root DB, account-bound methods; file changes recover from a durable write intent. */
export class ProfileStore {
  readonly db: DatabaseSync; readonly root: string;
  constructor(db: DatabaseSync, root: string) {
    this.db = db; this.root = root;
    db.exec(`CREATE TABLE IF NOT EXISTS channel_profile_revisions(account TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,saved_at INTEGER NOT NULL,PRIMARY KEY(account,revision)) STRICT;
      CREATE TABLE IF NOT EXISTS profile_change_intents(id TEXT PRIMARY KEY,account TEXT NOT NULL UNIQUE,oldHash TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,previous TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS thread_profiles(thread_id TEXT PRIMARY KEY,account TEXT NOT NULL,payload TEXT NOT NULL) STRICT;`);
    db.exec("CREATE TABLE IF NOT EXISTS thread_model_overrides(id INTEGER PRIMARY KEY,thread_id TEXT NOT NULL,account TEXT NOT NULL,model TEXT,effort TEXT,changed_at INTEGER NOT NULL) STRICT");
  }
  file(account: string): string { assertAccountName(account); return join(this.root, "profiles", account, "profile.json"); }
  current(account: string): Revision | undefined { assertAccountName(account); return this.db.prepare("SELECT revision,payload,hash FROM channel_profile_revisions WHERE account=? ORDER BY revision DESC LIMIT 1").get(account) as Revision | undefined; }
  readFile(account: string): string {
    const file = this.file(account);
    if (lstatSync(file).isSymbolicLink() || statSync(file).size > PROFILE_MAX_BYTES) throw new Error("配置文件不是普通文件或超过 64 KiB");
    const text = readFileSync(file, "utf8"); if (Buffer.byteLength(text) > PROFILE_MAX_BYTES) throw new Error("配置超过 64 KiB"); return text;
  }
  initialize(account: string): void {
    this.recover(account); if (this.current(account)) return;
    if (existsSync(this.file(account))) throw new Error("存在未登记配置，请先人工核对，未自动覆盖");
    this.save(account, defaultProfile(), "");
  }
  load(account: string): ChannelProfile {
    this.initialize(account); const row = this.current(account)!; const text = this.readFile(account);
    if (hash(text) !== row.hash) throw new Error("配置文件已被外部修改或损坏；请检查后发送 config reload。当前会话仍保留原快照");
    return validateProfile(JSON.parse(text));
  }
  reload(account: string, validate: (profile: ChannelProfile) => Promise<void>): Promise<ChannelProfile> {
    return (async () => { this.recover(account); const row = this.current(account); if (!row) throw new Error("配置未初始化");
      const text = this.readFile(account); const p = validateProfile(JSON.parse(text)); if (p.revision !== row.revision) throw new Error("手工编辑不能修改 revision");
      await validate(p); return this.save(account, p, hash(text)); })();
  }
  save(account: string, input: ChannelProfile, expectedHash?: string): ChannelProfile {
    this.recover(account); const old = this.current(account); const text = existsSync(this.file(account)) ? this.readFile(account) : "";
    const expected = expectedHash ?? old?.hash ?? "";
    if ((text ? hash(text) : "") !== expected) throw new Error("配置发生并发或外部修改，请重新读取/reload 后再保存");
    if (old && input.revision !== old.revision) throw new Error("配置修订已变化，请重新读取后再保存");
    const candidate = validateProfile({ ...input, revision: (old?.revision ?? 0) + 1 }); const payload = serialize(candidate);
    if (Buffer.byteLength(payload) > PROFILE_MAX_BYTES) throw new Error("格式化后配置超过 64 KiB");
    const intent: Intent = { id: randomUUID(), account, oldHash: expected, payload, hash: hash(payload), previous: old?.payload ?? "" };
    this.db.prepare("INSERT INTO profile_change_intents(id,account,oldHash,payload,hash,previous) VALUES(?,?,?,?,?,?)").run(intent.id, account, expected, payload, intent.hash, intent.previous);
    this.finish(intent); return candidate;
  }
  recover(account: string): void {
    assertAccountName(account); const intent = this.db.prepare("SELECT * FROM profile_change_intents WHERE account=?").get(account) as Intent | undefined;
    if (intent) this.finish(intent);
  }
  private finish(i: Intent): void {
    const text = existsSync(this.file(i.account)) ? this.readFile(i.account) : ""; const actual = text ? hash(text) : "";
    if (actual !== i.oldHash && actual !== i.hash) throw new Error("配置恢复遇到第三方修改，已停止，未覆盖文件");
    // Keep a validated backup, never an invalid manual edit.
    if (i.previous) atomicWrite(`${this.file(i.account)}.bak`, i.previous);
    if (actual !== i.hash) atomicWrite(this.file(i.account), i.payload);
    const p = validateProfile(JSON.parse(i.payload));
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.prepare("INSERT OR IGNORE INTO channel_profile_revisions(account,revision,payload,hash,saved_at) VALUES(?,?,?,?,?)").run(i.account, p.revision, i.payload, i.hash, Date.now());
      this.db.prepare("DELETE FROM profile_change_intents WHERE id=?").run(i.id); this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  snapshot(snapshot: Omit<ThreadProfile, "compilerVersion" | "instructionHash">): void {
    const payload: ThreadProfile = { ...snapshot, compilerVersion: COMPILER_VERSION, instructionHash: hash(snapshot.instructions) };
    this.db.prepare("INSERT INTO thread_profiles(thread_id,account,payload) VALUES(?,?,?)").run(snapshot.threadId, snapshot.account, JSON.stringify(payload));
  }
  thread(id: string, account?: string): ThreadProfile | null {
    const row = this.db.prepare("SELECT account,payload FROM thread_profiles WHERE thread_id=?").get(id) as { account: string; payload: string } | undefined;
    if (!row) return null; if (account !== undefined && row.account !== account) throw new Error("E_ACCOUNT_THREAD_OWNERSHIP");
    const snapshot = JSON.parse(row.payload) as ThreadProfile;
    if (snapshot.account !== row.account || snapshot.threadId !== id || hash(snapshot.instructions) !== snapshot.instructionHash) throw new Error("会话身份快照校验失败");
    validateProfile(snapshot.profile); return snapshot;
  }
  modelOverride(account: string, threadId: string, model: unknown, effort: unknown): void {
    assertAccountName(account); this.db.prepare("INSERT INTO thread_model_overrides(thread_id,account,model,effort,changed_at) VALUES(?,?,?,?,?)").run(threadId, account, typeof model === "string" ? model : null, typeof effort === "string" ? effort : null, Date.now());
  }
}
function atomicWrite(file: string, text: string): void {
  const directory = file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))); mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("配置目录不允许链接");
  const temp = `${file}.${randomUUID()}.tmp`; const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, file); } finally { if (existsSync(temp)) unlinkSync(temp); }
}
