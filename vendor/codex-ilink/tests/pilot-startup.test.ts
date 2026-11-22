import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { preparePilotStartup } from "../src/windows/pilot-startup.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "ilink-startup-pilot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deploymentRoot = join(root, "release"); const localAppDataDirectory = join(root, "local");
  mkdirSync(join(localAppDataDirectory, "Codex_iLink"), { recursive: true });
  const db = new DatabaseSync(join(localAppDataDirectory, "Codex_iLink", "state.sqlite"));
  db.exec("CREATE TABLE accounts(name TEXT PRIMARY KEY,user_id TEXT,bot_id TEXT)");
  db.prepare("INSERT INTO accounts VALUES(?,?,?)").run("primary", "synthetic-user", "synthetic-bot"); db.close();
  const files = ["vendor/codex-ilink/dist/cli/main.js", "vendor/codex-ilink/dist/cli/pilot-startup.js"];
  const entries = files.map(path => { const file = join(deploymentRoot, path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "// synthetic build\n"); return { path, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }; });
  writeFileSync(join(deploymentRoot, "manifest.json"), JSON.stringify({ version: 1, buildId: "synthetic-build", files: entries }));
  const config = { version: 1, deploymentRoot, localAppDataDirectory, account: "primary", identityFingerprint: createHash("sha256").update(JSON.stringify(["synthetic-user", "synthetic-bot"])).digest("hex"), mode: "explicit-only" };
  return { root, config };
}

test("login startup pins the same verified build and channel scope as manual startup", t => {
  const { config } = fixture(t);
  const launch = preparePilotStartup(config, { ...process.env, ILINK_V2_ACCOUNTS: "secondary", ILINK_MEMORY_RESPONSES_API_KEY: "synthetic-secret", ILINK_MEMORY_RESPONSES_MODEL: "unapproved-model" }, () => process.execPath);
  assert.equal(launch.args.at(-1), "__run");
  assert.equal(launch.args[1], join(config.deploymentRoot, "vendor", "codex-ilink", "dist", "cli", "main.js"));
  assert.equal(launch.environment.ILINK_V2_ACCOUNTS, "primary");
  assert.equal(launch.environment.LOCALAPPDATA, config.localAppDataDirectory);
  assert.equal(launch.environment.ILINK_MEMORY_RESPONSES_API_KEY, undefined);
  assert.equal(launch.environment.ILINK_MEMORY_RESPONSES_MODEL, undefined);
  assert.equal(launch.environment.CODEX_ILINK_CODEX_EXE, process.execPath);
  assert.equal(launch.buildId, "synthetic-build");
});

test("a changed account registry cannot silently move the pilot to another controller", t => {
  const { config } = fixture(t);
  const db = new DatabaseSync(join(config.localAppDataDirectory, "Codex_iLink", "state.sqlite"));
  db.prepare("UPDATE accounts SET user_id=? WHERE name=?").run("different-controller", "primary"); db.close();
  let resolved = false;
  assert.throws(() => preparePilotStartup(config, {}, () => { resolved = true; return process.execPath; }), /E_PILOT_ACCOUNT_CHANGED/);
  assert.equal(resolved, false);
});

test("a modified deployment fails closed instead of falling back to the old checkout", t => {
  const { config } = fixture(t);
  writeFileSync(join(config.deploymentRoot, "vendor", "codex-ilink", "dist", "cli", "main.js"), "// changed build\n");
  assert.throws(() => preparePilotStartup(config, {}, () => process.execPath), /E_PILOT_BUILD_CHANGED/);
});

test("unsupported scope, model mode and escaping manifest paths never become a startup command", t => {
  const { config } = fixture(t);
  assert.throws(() => preparePilotStartup({ ...config, account: "primary,secondary" }, {}, () => process.execPath), /E_PILOT_CONFIG_INVALID/);
  assert.throws(() => preparePilotStartup({ ...config, mode: "automatic" }, {}, () => process.execPath), /E_PILOT_CONFIG_INVALID/);
  writeFileSync(join(config.deploymentRoot, "manifest.json"), JSON.stringify({ version: 1, buildId: "invalid", files: [{ path: "../outside.js", sha256: "0".repeat(64) }] }));
  assert.throws(() => preparePilotStartup(config, {}, () => process.execPath), /E_PILOT_BUILD_INVALID/);
});


test("an explicitly verified multi-account deployment enables every selected account without a wildcard", t => {
 const {config}=fixture(t);const db=new DatabaseSync(join(config.localAppDataDirectory,"Codex_iLink","state.sqlite"));db.prepare("INSERT INTO accounts VALUES(?,?,?)").run("secondary","second-user","second-bot");db.close();
 const accounts=[{account:"primary",identityFingerprint:config.identityFingerprint},{account:"secondary",identityFingerprint:createHash("sha256").update(JSON.stringify(["second-user","second-bot"])).digest("hex")}];
 const launch=preparePilotStartup({...config,accounts},{},()=>process.execPath);assert.equal(launch.environment.ILINK_V2_ACCOUNTS,"primary,secondary");
 assert.throws(()=>preparePilotStartup({...config,accounts:[accounts[0],{...accounts[1],identityFingerprint:"0".repeat(64)}]},{},()=>process.execPath),/E_PILOT_ACCOUNT_CHANGED/);
});

test("restart enables interaction only for the fingerprint-verified scope and never inherits a broader environment",t=>{
 const {config}=fixture(t);const db=new DatabaseSync(join(config.localAppDataDirectory,"Codex_iLink","state.sqlite"));db.prepare("INSERT INTO accounts VALUES(?,?,?)").run("secondary","second-user","second-bot");db.close();
 const accounts=[{account:"primary",identityFingerprint:config.identityFingerprint},{account:"secondary",identityFingerprint:createHash("sha256").update(JSON.stringify(["second-user","second-bot"])).digest("hex")}];
 const launch=preparePilotStartup({...config,accounts,interactionEnabled:true},{ILINK_INTERACTION_ACCOUNTS:"unapproved"},()=>process.execPath);assert.equal(launch.environment.ILINK_INTERACTION_ACCOUNTS,"primary,secondary");
 const disabled=preparePilotStartup(config,{ILINK_INTERACTION_ACCOUNTS:"primary,secondary"},()=>process.execPath);assert.equal(disabled.environment.ILINK_INTERACTION_ACCOUNTS,undefined);
 assert.throws(()=>preparePilotStartup({...config,interactionEnabled:"yes"},{},()=>process.execPath),/E_PILOT_CONFIG_INVALID/);
});
