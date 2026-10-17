import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableWindowsStartupTask } from '../vendor/codex-ilink/src/windows/startup-task.ts';
import { findDesktopCodexExecutable } from '../vendor/codex-ilink/src/windows/host.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stateFile = join(process.env.LOCALAPPDATA, 'Codex_iLink', 'state.sqlite');
if (!existsSync(stateFile)) throw new Error('Existing iLink state required');
// Resolve the file, not its parent: MSIX may redirect files while reporting
// an unredirected parent directory.
const stateDirectory = dirname(realpathSync.native(stateFile));
enableWindowsStartupTask({
  executable: realpathSync.native(process.execPath),
  hostScript: join(root, 'vendor', 'codex-ilink', 'dist', 'windows', 'startup-host.vbs'),
  args: ['--disable-warning=ExperimentalWarning', '--experimental-strip-types',
    join(root, 'scripts', 'startup-bridge.mjs'), dirname(stateDirectory),
    realpathSync.native(findDesktopCodexExecutable())],
});
console.log('已启用当前用户登录启动，并固定已绑定状态库与 Codex 可执行路径。');
