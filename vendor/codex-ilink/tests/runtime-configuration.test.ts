import assert from "node:assert/strict";
import{mkdtempSync,rmSync,writeFileSync}from"node:fs";
import{tmpdir}from"node:os";
import{join}from"node:path";
import test from"node:test";
import{runtimeConfigurationFingerprint}from"../src/windows/runtime-configuration.ts";

test("native tool pipe rotation changes the runtime signal without returning configuration content",t=>{
  const home=mkdtempSync(join(tmpdir(),"ilink-tool-config-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const env={CODEX_HOME:home};
  writeFileSync(join(home,"config.toml"),'[mcp_servers.node_repl.env]\nSKY_CUA_NATIVE_PIPE_DIRECTORY="old-pipe"\n');
  const old=runtimeConfigurationFingerprint(env);
  assert.match(old,/^[a-f0-9]{64}$/);
  assert.equal(runtimeConfigurationFingerprint(env),old);
  writeFileSync(join(home,"config.toml"),'[mcp_servers.node_repl.env]\nSKY_CUA_NATIVE_PIPE_DIRECTORY="new-pipe"\n');
  assert.notEqual(runtimeConfigurationFingerprint(env),old);
});

test("an absent configuration has a stable signal and is detected when created later",t=>{
  const home=mkdtempSync(join(tmpdir(),"ilink-tool-config-empty-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  assert.equal(runtimeConfigurationFingerprint({CODEX_HOME:home}),"absent");
  writeFileSync(join(home,"config.toml"),'model="fixture"');
  assert.notEqual(runtimeConfigurationFingerprint({CODEX_HOME:home,USERPROFILE:"unused"}),"absent");
  assert.throws(()=>runtimeConfigurationFingerprint({}),/CONFIG_HOME_REQUIRED/);
});
