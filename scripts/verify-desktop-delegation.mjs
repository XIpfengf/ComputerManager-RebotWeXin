// P0 only: run from a Desktop-provided environment, against an explicitly
// authorized acceptance thread. Never registers or restarts the live Bridge.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppServerConnection} from '../vendor/codex-ilink/src/codex/app-server-connection.ts';
import {SqliteTurnLeaseStore} from '../vendor/codex-ilink/src/coordination/turn-lease.ts';
import {desktopCodexAppServerCommand} from '../vendor/codex-ilink/src/windows/host.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[process.argv.indexOf('--target') + 1];
assert(process.argv.includes('--target') && /^[0-9a-f-]{36}$/i.test(target ?? ''), 'Explicit --target <acceptance-thread-id> required');
assert(process.env.CODEX_APP_TOOLS_PIPE_PATH, 'E_DESKTOP_APP_TOOLS_ENDPOINT_UNAVAILABLE: run from a Desktop-provided environment');
const home = process.env.CODEX_HOME ?? join(process.env.USERPROFILE, '.codex');
const pluginRoot = join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
const versions = readdirSync(pluginRoot).filter(x => /^\d+\.\d+\.\d+$/.test(x)).sort((a,b) => a.localeCompare(b, 'en', {numeric:true}));
assert(versions.length, 'Official bundled codex-app-tools package unavailable');
const server = join(pluginRoot, versions.at(-1), 'server.mjs');
const runId = randomUUID();
const marker = `DLG_${runId.replaceAll('-', '')}`;
const directory = join(root, '.local', 'delegation-acceptance', runId);
mkdirSync(directory, {recursive:true});
const database = join(directory, 'leases.sqlite');
const leases = new SqliteTurnLeaseStore(database);
const instance = `delegation-probe-${runId}`;
const connection = await AppServerConnection.create({
  bridgeInstanceId:instance, command:desktopCodexAppServerCommand(),
  environment:{...process.env, CODEX_ILINK_LEASE_DB:database}, requestTimeoutMs:45000,
});
let lease;
let timer;
let ownThread;
const items = [];
let complete;
const completion = new Promise(resolve => { complete = resolve; });
connection.onEvent(event => {
  if (event.params.threadId !== ownThread) return;
  if (event.method === 'item/completed') items.push(event.params.item);
  if (event.method === 'turn/completed') complete(event.params.turn);
  if (event.id !== undefined) connection.respondToServerRequest(event.id, {decision:'decline'});
});
try {
  // Restrict the harness to a prepared fixture, not an arbitrary business chat.
  const history = await connection.request('thread/turns/list', {threadId:target, limit:50, sortDirection:'asc', itemsView:'summary'});
  assert(history.data.some(t => t.items.some(i => i.type === 'agentMessage' && i.text === 'DESKTOP_TARGET_READY')), 'Target is not a prepared acceptance fixture');
  const metadata = await connection.request('thread/read', {threadId:target, includeTurns:false});
  assert(metadata.thread.cwd, 'Acceptance target has no workspace');
  const proofName = `ilink-delegation-${runId}.txt`;
  const proofPath = join(metadata.thread.cwd, 'outputs', proofName);
  assert(!existsSync(proofPath), 'Acceptance proof already exists');
  const started = await connection.request('thread/start', {
    cwd:root, ephemeral:false, approvalPolicy:'never', sandbox:'read-only',
    config:{'mcp_servers.codex_app':{
      enabled:true, command:process.execPath, args:[server],
      enabled_tools:['read_thread', 'send_message_to_thread', 'wait_threads'],
      default_tools_approval_mode:'approve',
      env_vars:['CODEX_APP_TOOLS_PIPE_PATH', 'USERPROFILE', 'LOCALAPPDATA', 'PATH'],
      env:{CODEX_APP_TOOLS_DEFERRED:'0'},
    }},
  });
  ownThread = started.thread.id;
  lease = {threadId:ownThread, owner:'bridge', instanceId:instance, operationId:runId, turnId:null, createdAtMs:Date.now()};
  assert(leases.tryAcquire(lease).acquired, 'Own isolated lease unavailable');
  timer = setTimeout(() => complete(null), 90000);
  const turn = await connection.request('turn/start', {
    threadId:ownThread, clientUserMessageId:randomUUID(),
    input:[{type:'text', text_elements:[], text:
      `用户授权的隔离委派验收。唯一允许发送消息的目标为 ${target}，hostId=local。` +
      `用 codex_app.send_message_to_thread 发送一次：用户授权隔离验收 ${marker}，计算 523×37，在你当前会话工作目录的 outputs/${proofName} 新建 UTF-8 文本文件，内容为 ${marker} RESULT=<结果>，再读取该文件确认内容。只允许操作这个新测试文件，不修改其他文件、不联系其他会话；成功最终回复中写出 ${marker} RESULT=<结果> 和 FILE_PROOF_OK。` +
      `之后用 codex_app.wait_threads 等待目标本次回合完成，核对唯一标记，再在你自己的最终回复中给出 ${marker} RELAY_OK、目标结果和完成回合编号。` +
      '只使用上述两个工具；不修改模型和设置，不重发，不操作其他会话。失败则如实报告。',
    }],
  });
  const finished = await completion;
  assert(finished?.status === 'completed', 'Origin turn incomplete; do not blindly resend');
  const calls = items.filter(i => i?.type === 'mcpToolCall');
  const sends = calls.filter(i => i.tool === 'send_message_to_thread');
  assert.equal(sends.length, 1, 'Expected exactly one send');
  assert.equal(sends[0].arguments.threadId, target);
  assert.equal(sends[0].status, 'completed');
  assert(!sends[0].error && !sends[0].result?.isError, 'Send failed');
  const waits = calls.filter(i => i.tool === 'wait_threads' && i.status === 'completed' && !i.error);
  assert(waits.length, 'No successful result wait');
  const expected = `${marker} RESULT=19351`;
  const returned = finished.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n');
  assert(/\b19351\b/.test(returned) && returned.includes(`${marker} RELAY_OK`), 'Missing exact result and relay marker');
  const targetTurns = await connection.request('thread/turns/list', {threadId:target, limit:10, sortDirection:'desc', itemsView:'summary'});
  const resultTurn = targetTurns.data.find(t => t.status === 'completed' && t.items.some(i => i.type === 'agentMessage' && i.text.includes(expected) && i.text.includes('FILE_PROOF_OK')));
  assert(resultTurn && returned.includes(resultTurn.id), 'No matching completed target turn');
  const receipts = waits.flatMap(i => (i.result?.content ?? []).filter(c => c.type === 'text').map(c => {try{return JSON.parse(c.text);}catch{return null;}})).filter(Boolean);
  assert(receipts.some(r => r.polls?.some(p => p.thread?.id === target && p.latestTurn?.id === resultTurn.id && p.latestTurn.status === 'completed' && p.latestAssistantMessage?.text?.includes(expected) && p.latestAssistantMessage.text.includes('FILE_PROOF_OK'))), 'Wait receipt does not match exact target turn');
  assert.equal(readFileSync(proofPath, 'utf8').replace(/^\uFEFF/, '').trim(), expected, 'Disk proof differs from delegated result');
  const report = {passed:true, targetThread:target, targetTurn:resultTurn.id, originThread:ownThread, originTurn:turn.turn.id, marker, result:19351, fileProofVerified:true, singleSend:true, guardLeaseUsed:true, scope:'Independent middleware AppServer -> official Desktop MCP -> existing Desktop fixture -> file write and readback -> wait receipt -> origin final answer'};
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(timer);
  // Release only this test's lease, after terminating its own connection.
  connection.close();
  writeFileSync(join(directory, 'tool-evidence.json'), JSON.stringify(items, null, 2));
  if (lease) { const held = leases.getLease(lease.threadId); if (held?.instanceId === instance) leases.release(held); }
  leases.close();
}
