import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";

/** Detect tool/pipe configuration rotation without retaining or logging secrets. */
export function runtimeConfigurationFingerprint(environment: NodeJS.ProcessEnv = process.env): string {
  const home=environment.CODEX_HOME ?? (environment.USERPROFILE ? join(environment.USERPROFILE,".codex") : undefined);
  if (!home) throw new Error("E_CODEX_CONFIG_HOME_REQUIRED");
  try {return createHash("sha256").update(readFileSync(join(home,"config.toml"))).digest("hex");}
  catch(error){if((error as NodeJS.ErrnoException).code === "ENOENT")return "absent";throw error;}
}
