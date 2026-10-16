import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SqliteTurnLeaseStore } from '../vendor/codex-ilink/src/coordination/turn-lease.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, '.local', 'guard-acceptance', randomUUID());
mkdirSync(directory,{recursive:true});
const database = join(directory,'leases.sqlite');
const store = new SqliteTurnLeaseStore(database);
const threadId = randomUUID();
const lease = {threadId,instanceId:randomUUID(),operationId:randomUUID(),owner:'bridge',turnId:null,createdAtMs:Date.now()};
const hook = turnId => {
  const env = {...process.env,CODEX_ILINK_LEASE_DB:database};
  delete env.CODEX_ILINK_BRIDGE;
  delete env.CODEX_ILINK_BRIDGE_INSTANCE;
  const result=spawnSync(process.execPath,[join(root,'vendor','codex-ilink','dist','cli','launcher.js'),'__hook','turn','UserPromptSubmit'],{
    cwd:root,env,encoding:'utf8',windowsHide:true,timeout:10000,
    input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:threadId,turn_id:turnId,cwd:root}),
  });
  if(result.error||result.status!==0)throw new Error('Installed hook command failed');
  return result.stdout.trim()?JSON.parse(result.stdout):{};
};
try {
  if(!store.tryAcquire(lease).acquired)throw new Error('Fixture lease unavailable');
  const blocked=hook('desktop-first');
  if(blocked.continue!==false||blocked.stopReason!=='CODEX_ILINK_THREAD_BUSY')throw new Error('Guard did not block conflicting turn');
  store.release(lease);
  const allowed=hook('desktop-second');
  if(allowed.continue===false)throw new Error('Guard did not allow released thread');
  const blockedAgain=hook('desktop-third');
  if(blockedAgain.continue!==false)throw new Error('Guard did not retain desktop ownership');
  const report={bridgeConflictBlocked:true,releasedThreadAllowed:true,secondDesktopTurnBlocked:true,
    scope:'Direct installed Hook command with isolated SQLite; does not prove Codex trust or Desktop integration'};
  writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{store.close();}
