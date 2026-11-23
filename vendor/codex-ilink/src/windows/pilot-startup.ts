import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findDesktopCodexExecutable } from "./host.ts";

export type PilotStartupConfig = {
  version: 1;
  deploymentRoot: string;
  localAppDataDirectory: string;
  accounts?: Array<{account:string;identityFingerprint:string}>;
  account: string;
  identityFingerprint: string;
  mode: "explicit-only";
  interactionEnabled?:boolean;
};

/** Validate a fixed local deployment and its authenticated account before starting anything. */
export function preparePilotStartup(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  resolveCodex: () => string = () => findDesktopCodexExecutable(environment),
): { executable: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; buildId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("E_PILOT_CONFIG_INVALID");
  const config = input as PilotStartupConfig;
  if(config.interactionEnabled!==undefined&&typeof config.interactionEnabled!=="boolean")throw Error("E_PILOT_CONFIG_INVALID");
  if (config.version !== 1 || config.mode !== "explicit-only" || typeof config.account !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(config.account)
    || typeof config.identityFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(config.identityFingerprint)
    || typeof config.deploymentRoot !== "string" || !isAbsolute(config.deploymentRoot)
    || typeof config.localAppDataDirectory !== "string" || !isAbsolute(config.localAppDataDirectory)) throw Error("E_PILOT_CONFIG_INVALID");
  const accounts=config.accounts??[{account:config.account,identityFingerprint:config.identityFingerprint}];
  if(!Array.isArray(accounts)||!accounts.length||accounts.length>100||new Set(accounts.map(a=>a?.account)).size!==accounts.length||accounts.some(a=>!a||typeof a.account!=="string"||!/^[a-z][a-z0-9-]{0,31}$/u.test(a.account)||typeof a.identityFingerprint!=="string"||!/^[a-f0-9]{64}$/u.test(a.identityFingerprint)))throw Error("E_PILOT_CONFIG_INVALID");
  const root = realpathSync.native(config.deploymentRoot);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { version: number; buildId: string; files: Array<{ path: string; sha256: string }> };
  if (manifest.version !== 1 || typeof manifest.buildId !== "string" || !manifest.buildId || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) throw Error("E_PILOT_BUILD_INVALID");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || isAbsolute(file.path) || file.path.includes("\0") || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw Error("E_PILOT_BUILD_INVALID");
    const path = resolve(root, file.path);
    const contained = relative(root, path);
    if (!contained || contained.startsWith("..") || isAbsolute(contained) || seen.has(path.toLowerCase())) throw Error("E_PILOT_BUILD_INVALID");
    seen.add(path.toLowerCase());
    const actual = realpathSync.native(path);
    const actualRelative = relative(root, actual);
    if (actualRelative.startsWith("..") || isAbsolute(actualRelative) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
      || createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) throw Error("E_PILOT_BUILD_CHANGED");
  }
  const packageRoot = join(root, "vendor", "codex-ilink");
  const entrypoint = join(packageRoot, "dist", "cli", "main.js");
  const startupEntrypoint = join(packageRoot, "dist", "cli", "pilot-startup.js");
  if (!seen.has(entrypoint.toLowerCase()) || !seen.has(startupEntrypoint.toLowerCase())) throw Error("E_PILOT_BUILD_INVALID");
  const databasePath = realpathSync.native(join(config.localAppDataDirectory, "Codex_iLink", "state.sqlite"));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for(const selected of accounts){
    const row = db.prepare("SELECT user_id,bot_id FROM accounts WHERE name=?").get(selected.account);
    if (!row || createHash("sha256").update(JSON.stringify([row.user_id, row.bot_id])).digest("hex") !== selected.identityFingerprint) throw Error("E_PILOT_ACCOUNT_CHANGED");
    }
  } finally { db.close(); }
  const codexExecutable = resolveCodex();
  const childEnvironment = { ...environment };
  for (const name of Object.keys(childEnvironment)) {
    if (name.toUpperCase() === "ILINK_V2_ACCOUNTS" ||name.toUpperCase()==="ILINK_INTERACTION_ACCOUNTS"|| name.toUpperCase().startsWith("ILINK_MEMORY_RESPONSES_")) delete childEnvironment[name];
  }
  Object.assign(childEnvironment, { LOCALAPPDATA: dirname(dirname(databasePath)), CODEX_ILINK_CODEX_EXE: codexExecutable, ILINK_V2_ACCOUNTS: accounts.map(a=>a.account).join(",") });
  if(config.interactionEnabled)childEnvironment.ILINK_INTERACTION_ACCOUNTS=accounts.map(a=>a.account).join(",");
  return { executable: process.execPath, args: ["--disable-warning=ExperimentalWarning", entrypoint, "__run"], cwd: packageRoot, environment: childEnvironment, buildId: manifest.buildId };
}
