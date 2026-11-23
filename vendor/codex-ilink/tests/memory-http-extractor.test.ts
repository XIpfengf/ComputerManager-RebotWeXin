import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesMemoryExtractor, configuredMemoryExtractor } from "../src/memory/http-extractor.ts";

test("HTTP extraction exposes no tools, existing conversation, credentials or runtime to the model", async () => {
  let calls = 0;
  const extractor = new ResponsesMemoryExtractor({ model: "synthetic-model", apiKey: () => "synthetic-secret", fetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init!.body));
    assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 1024); assert.equal(body.text.format.type, "json_schema");
    assert.doesNotMatch(JSON.stringify(body), /synthetic-secret|previous_response_id|threadId|sandbox|send_file|delegate_task/);
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer synthetic-secret");
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ facts: [] }) }] }] }));
  } });
  assert.deepEqual(await extractor.extract({ evidence: [{ id: "e1", text: "我喜欢米饭" }], signal: new AbortController().signal, maxOutputBytes: 4096 }), { facts: [] });
  assert.equal(calls, 1);
});

test("refusals, incomplete responses, tool attempts and excessive bodies cannot produce memory facts", async () => {
  for (const payload of [
    { status: "incomplete", output: [] },
    { status: "completed", output: [{ type: "function_call", name: "exec" }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(70000) }] }] },
  ]) {
    const extractor = new ResponsesMemoryExtractor({ model: "synthetic", apiKey: () => "fake", fetch: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(extractor.extract({ evidence: [{ id: "e", text: "我喜欢饭" }], signal: new AbortController().signal, maxOutputBytes: 4096 }), /E_EXTRACTION_/);
  }
  assert.equal(configuredMemoryExtractor({ ILINK_MEMORY_RESPONSES_MODEL: "test", ILINK_MEMORY_RESPONSES_API_KEY: "fake", ILINK_MEMORY_RESPONSES_ENDPOINT: "http://example.invalid" }), undefined);
});

test("provider usage is reported separately from model facts and never guessed when unavailable", async () => {
  const extractor = new ResponsesMemoryExtractor({ model: "synthetic", apiKey: () => "fake", fetch: async () => new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 37, output_tokens: 11 }, output: [{ type: "message", content: [{ type: "output_text", text: '{"facts":[]}' }] }] })) });
  assert.equal(extractor.metrics().inputTokens, null);
  assert.deepEqual(await extractor.extract({ evidence: [{ id: "e", text: "我喜欢米饭" }], signal: new AbortController().signal, maxOutputBytes: 4096 }), { facts: [] });
  assert.equal(extractor.metrics().inputTokens, 37); assert.equal(extractor.metrics().outputTokens, 11);
  assert.equal(extractor.metrics().httpRequestsStarted, 1); assert.equal(extractor.metrics().unobservedUsageRequests, 0);
});
