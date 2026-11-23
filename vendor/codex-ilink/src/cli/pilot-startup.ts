import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentHostStatus } from "./ilink.ts";
import { preparePilotStartup } from "../windows/pilot-startup.ts";

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw Error("E_PILOT_CONFIG_REQUIRED");
  const text = readFileSync(configPath, "utf8");
  if (Buffer.byteLength(text) > 16384) throw Error("E_PILOT_CONFIG_INVALID");
  const plan = preparePilotStartup(JSON.parse(text));
  const ownPath = realpathSync.native(fileURLToPath(import.meta.url));
  if (ownPath !== realpathSync.native(join(plan.cwd, "dist", "cli", "pilot-startup.js"))) throw Error("E_PILOT_ENTRYPOINT_MISMATCH");
  if (await currentHostStatus()) throw Error("E_PILOT_BRIDGE_ALREADY_RUNNING");
  const logs = join(plan.environment.LOCALAPPDATA!, "Codex_iLink", "logs");
  mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, "pilot-startup.log"), "a");
  try {
    const child = spawn(plan.executable, plan.args, { cwd: plan.cwd, env: plan.environment, windowsHide: true, shell: false, stdio: ["ignore", log, log] });
    child.once("error", () => { process.stderr.write("E_PILOT_CHILD_START_FAILED\n"); process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
    writeFileSync(join(dirname(configPath), "launch-receipt.json"), JSON.stringify({ requestedAt: new Date().toISOString(), pid: child.pid, buildId: plan.buildId, entrypoint: plan.args[1], featureScope: plan.environment.ILINK_V2_ACCOUNTS!.split(","),interactionScope:plan.environment.ILINK_INTERACTION_ACCOUNTS?.split(",")??[], explicitOnly: true }, null, 2));
  } finally { closeSync(log); }
}

void main().catch(error => {
  const code = error instanceof Error && /^E_[A-Z0-9_]+$/u.test(error.message) ? error.message : "E_PILOT_STARTUP_FAILED";
  if (process.argv[2]) {
    try { appendFileSync(join(dirname(process.argv[2]), "startup-errors.log"), `${new Date().toISOString()} ${code}\n`); } catch { /* Preserve the original startup failure. */ }
  }
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
