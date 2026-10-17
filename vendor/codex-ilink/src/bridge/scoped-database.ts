import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Scope upstream state tables inside ONE SQLite file. turn_leases intentionally
 * remains global, preserving dispatch admission + lease release transactions.
 * Only internal SQL identifiers are rewritten; quoted literals and bound data
 * remain unchanged. Tables/indexes/triggers are collected from our migrations.
 */
export function scopedDatabase(database: DatabaseSync, scope: string): DatabaseSync {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(scope)) throw new Error("E_INVALID_ACCOUNT_SCOPE");
  const prefix = `account_${Buffer.from(scope).toString("hex")}_`;
  const location = process.env.CODEX_ILINK_PACKAGE_ROOT
    ? join(process.env.CODEX_ILINK_PACKAGE_ROOT, "dist", "bridge", "migrations")
    : new URL("./migrations/", import.meta.url);
  const identifiers = new Set<string>();
  for (const name of readdirSync(location)) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(typeof location === "string" ? join(location, name) : new URL(name, location), "utf8");
    for (const match of sql.matchAll(/CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/giu)) identifiers.add(match[1]!.toLowerCase());
  }
  database.exec("CREATE TABLE IF NOT EXISTS account_schemas(scope TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT");
  database.prepare("INSERT OR IGNORE INTO account_schemas(scope,version) VALUES(?,0)").run(scope);
  const rewrite = (sql: string): string => {
    if (/^\s*PRAGMA user_version\s*;?\s*$/iu.test(sql)) return `SELECT version AS user_version FROM account_schemas WHERE scope='${scope}'`;
    const version = /^\s*PRAGMA user_version\s*=\s*(\d+)\s*;?\s*$/iu.exec(sql);
    if (version) return `UPDATE account_schemas SET version=${version[1]} WHERE scope='${scope}'`;
    return sql.replace(/'(?:''|[^'])*'|\b[a-z_][a-z0-9_]*\b/giu, token => identifiers.has(token.toLowerCase()) ? prefix + token : token);
  };
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => target.prepare(rewrite(sql));
      if (key === "exec") return (sql: string) => target.exec(rewrite(sql));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
