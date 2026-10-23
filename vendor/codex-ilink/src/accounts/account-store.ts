import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteState } from "../bridge/sqlite-state.ts";

export const PRIMARY_ACCOUNT = "primary";
export function assertAccountName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(name)) throw new Error("账号别名须为小写字母开头的 1–32 位字母、数字或连字符");
}

/** Account metadata and durable thread ownership; never stores plaintext tokens. */
export class AccountStore {
  readonly database: DatabaseSync;
  readonly root: string;
  constructor(root: string) {
    const originalState = join(root, "state.sqlite");
    this.root = existsSync(originalState) ? dirname(realpathSync.native(originalState)) : root;
    mkdirSync(this.root, { recursive: true });
    this.database = new DatabaseSync(join(this.root, "state.sqlite"));
    this.database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS thread_accounts (thread_id TEXT PRIMARY KEY, account_name TEXT NOT NULL) STRICT;`);
  }
  stateDirectory(name: string): string {
    assertAccountName(name);
    return name === PRIMARY_ACCOUNT ? this.root : join(this.root, "accounts", name);
  }
  openState(name: string): SqliteState {
    assertAccountName(name);
    return new SqliteState(join(this.root, "state.sqlite"), name === PRIMARY_ACCOUNT ? undefined : name);
  }
  list(): Array<{ name: string; userId: string; botId: string }> {
    return this.database.prepare("SELECT name,user_id AS userId,bot_id AS botId FROM accounts ORDER BY name").all() as Array<{ name: string; userId: string; botId: string }>;
  }
  register(name: string, userId: string, botId: string): void {
    assertAccountName(name);
    this.database.prepare("INSERT INTO accounts(name,user_id,bot_id) VALUES(?,?,?)").run(name, userId, botId);
  }
  importPrimary(): void {
    const state = new SqliteState(join(this.root, "state.sqlite"));
    try {
      const session = state.getILinkSession();
      if (!session) throw new Error("请先绑定主微信");
      const existing = this.list().find(a => a.name === PRIMARY_ACCOUNT);
      if (!existing) this.register(PRIMARY_ACCOUNT, session.controllerUserId, session.botId);
      else if (existing.userId !== session.controllerUserId || existing.botId !== session.botId) {
        // Explicit primary re-login may change bot identity, but cannot steal another account.
        this.database.prepare("UPDATE accounts SET user_id=?,bot_id=? WHERE name=?").run(session.controllerUserId, session.botId, PRIMARY_ACCOUNT);
      }
      const main = state.getBridgeSettings().mainThreadId;
      if (main) this.claimThread(PRIMARY_ACCOUNT, main);
    } finally { state.close(); }
  }
  owner(threadId: string): string {
    const row = this.database.prepare("SELECT account_name AS name FROM thread_accounts WHERE thread_id=?").get(threadId) as { name: string } | undefined;
    // Existing Desktop/history stays with the original account. New secondary
    // threads are explicitly registered before being used by its Bridge.
    return row?.name ?? PRIMARY_ACCOUNT;
  }
  explicitOwner(threadId:string):string|undefined {return (this.database.prepare("SELECT account_name AS name FROM thread_accounts WHERE thread_id=?").get(threadId) as {name:string}|undefined)?.name;}
  claimThread(name: string, threadId: string): void {
    assertAccountName(name);
    this.database.prepare("INSERT OR IGNORE INTO thread_accounts(thread_id,account_name) VALUES(?,?)").run(threadId, name);
    if (this.owner(threadId) !== name) throw new Error("E_ACCOUNT_THREAD_OWNERSHIP");
  }
  close(): void { this.database.close(); }
}
