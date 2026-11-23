import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/accounts/account-store.ts";
import { MemoryProvenance } from "../src/memory/provenance.ts";

test("external and unknown evidence stays ineligible after derivation, restart and forged ownership", t => {
  const root = mkdtempSync(join(tmpdir(), "ilink-provenance-")); let accounts = new AccountStore(root);
  t.after(() => { accounts.close(); rmSync(root, { recursive: true, force: true }); });
  accounts.register("primary", "a", "bot-a"); accounts.register("second", "b", "bot-b");
  accounts.claimThread("primary", "a1"); accounts.claimThread("second", "b1");
  let p = new MemoryProvenance(accounts, "primary");
  p.original({ id: "local", threadId: "a1", messageId: "m1", kind: "channel-original" });
  p.reference({ id: "tool", threadId: "a1", messageId: "t1" });
  p.derive({ id: "summary", threadId: "a1", messageId: "s1", parents: ["local", "tool"] });
  p.derive({ id: "translation", threadId: "a1", messageId: "s2", parents: ["summary"] });
  assert.equal(p.check("local", "a1").eligible, true);
  assert.deepEqual(p.check("summary", "a1"), { eligible: false, kind: "mixed", reason: "derived-reference" });
  assert.equal(p.check("translation", "a1").eligible, false);
  p.derive({ id: "missing", threadId: "a1", messageId: "s3", parents: ["not-recorded"] });
  assert.equal(p.check("missing", "a1").kind, "unknown");
  // Reusing an id cannot relabel a reference as original.
  assert.throws(() => p.original({ id: "tool", threadId: "a1", messageId: "t1", kind: "channel-original" }), /E_PROVENANCE_COLLISION/);
  assert.throws(() => p.original({ id: "forged", threadId: "b1", messageId: "b1", kind: "channel-original" }), /E_PROVENANCE_OWNERSHIP/);
  accounts.close(); accounts = new AccountStore(root); p = new MemoryProvenance(accounts, "primary");
  assert.equal(p.check("translation", "a1").eligible, false);
  assert.equal(p.check("local", "b1").eligible, false);
  assert.equal(p.check("local", "unowned").eligible, false);
});
