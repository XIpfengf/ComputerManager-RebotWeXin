import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [localAppDataDirectory, codexExecutable] = process.argv.slice(2);
for (const path of [localAppDataDirectory, codexExecutable]) {
  if (!path || !isAbsolute(path) || !existsSync(path)) throw new Error('Startup path unavailable');
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const implementation = join(root, 'vendor', 'codex-ilink');
const logDirectory = join(localAppDataDirectory, 'Codex_iLink', 'logs');
mkdirSync(logDirectory, {recursive:true});
const log = openSync(join(logDirectory, 'startup.log'), 'a');
try {
  // Only the scheduled child receives these explicit environment values.
  // Store-packaged Codex redirects LocalAppData; reuse its actual bound state.
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning',
    '--experimental-strip-types', join(implementation, 'src', 'cli', 'main.ts'), '__run'], {
    cwd: implementation,
    env: {...process.env, LOCALAPPDATA:localAppDataDirectory, CODEX_ILINK_CODEX_EXE:codexExecutable},
    shell:false, windowsHide:true, stdio:['ignore',log,log],
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {closeSync(log);}
