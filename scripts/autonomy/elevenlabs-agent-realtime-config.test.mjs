import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./elevenlabs-bootstrap-nova.mjs", import.meta.url), "utf8");

test("keeps the NOVA agents fast without abandoning turn-taking", () => {
  assert.match(source, /turn_eagerness:\s*"eager"/);
  assert.match(source, /turn_model:\s*"turn_v3"/);
  assert.match(source, /speculative_turn:\s*true/);
  assert.match(source, /turn_timeout:\s*7/);
  assert.match(source, /client_events:[\s\S]*"interruption"[\s\S]*"agent_response_correction"/);
  assert.match(source, /disable_first_message_interruptions:\s*true/);
});

test("makes Valerie livelier while preserving the configured voice", () => {
  assert.match(source, /stability:\s*0\.48/);
  assert.match(source, /speed:\s*1\.08/);
  assert.match(source, /temperature:\s*0\.35/);
});

test("bounds LLM and RAG work on every realtime turn", () => {
  assert.match(source, /LLM_MODEL[\s\S]*"gemini-2\.5-flash-lite"/);
  assert.match(source, /LLM_FALLBACK[\s\S]*"gpt-4o-mini"/);
  assert.match(source, /max_tokens:\s*180/);
  assert.match(source, /ignore_default_personality:\s*true/);
  assert.match(source, /enable_reasoning_summary:\s*false/);
  assert.match(source, /max_documents_length:\s*6000/);
  assert.match(source, /max_retrieved_rag_chunks_count:\s*4/);
});

test("waits explicitly when the associate still owns the turn", () => {
  assert.match(source, /skip_turn:\s*\{/);
  assert.match(source, /system_tool_type:\s*"skip_turn"/);
  assert.match(source, /No hables encima del asociado/);
  assert.match(source, /usa skip_turn y guarda silencio/);
  assert.match(source, /interruption_ignore_terms:[\s\S]*"ajá"[\s\S]*"claro"/);
});

test("preserves an explicitly selected externally managed renewal agent", () => {
  assert.match(source, /NOVA_EL_PRESERVE_AGENT_A/);
  assert.match(source, /preservePreferredId/);
  assert.match(source, /Preserving \$\{name\} requires an explicit preferred agent id/);
  assert.match(source, /selected\.agent_id !== preferredId/);
  assert.match(source, /RENOVACION_PRESERVED/);
});
