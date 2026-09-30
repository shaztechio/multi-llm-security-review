// Copyright 2026 Shazron Abdullah
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Run with: node --test scripts/stream-summary.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeStreamLine } from "./stream-summary.mjs";

const line = (event) => JSON.stringify(event);

test("a tool call prints the tool and its target, never the model's text", () => {
  const summary = summarizeStreamLine(line({
    type: "assistant",
    message: { content: [
      { type: "text", text: "SECRET FINDING: the admin password is hunter2" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "apps/dotnet/src/Core/BackupManager.cs" } },
    ] },
  }));
  assert.equal(summary, "Read apps/dotnet/src/Core/BackupManager.cs");
  assert.doesNotMatch(summary, /SECRET|hunter2/);
});

test("several calls in one message and pattern targets", () => {
  const summary = summarizeStreamLine(line({
    type: "assistant",
    message: { content: [
      { type: "tool_use", name: "Glob", input: { pattern: "**/*.cs" } },
      { type: "tool_use", name: "Grep", input: { pattern: "Process.Start", path: "apps" } },
    ] },
  }));
  assert.equal(summary, "Glob **/*.cs; Grep apps");
});

test("tool results, file contents and text-only messages print nothing", () => {
  assert.equal(summarizeStreamLine(line({ type: "user", message: { content: [{ type: "tool_result", content: "password=hunter2" }] } })), null);
  assert.equal(summarizeStreamLine(line({ type: "assistant", message: { content: [{ type: "text", text: "thinking about a bug" }] } })), null);
  assert.equal(summarizeStreamLine(line({ type: "stream_event", event: {} })), null);
});

test("session start and API retries are reported", () => {
  assert.equal(
    summarizeStreamLine(line({ type: "system", subtype: "init", model: "z-ai/glm-5.3", tools: ["Read", "Edit"] })),
    "session started (model z-ai/glm-5.3, 2 tools)");
  assert.equal(
    summarizeStreamLine(line({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 402, error: "billing_error" })),
    "API retry 2/10: (HTTP 402), next in 4s");
});

test("successful and failed results keep free-form text out", () => {
  const ok = summarizeStreamLine(line({ type: "result", subtype: "success", is_error: false, result: "I found a critical flaw in auth", num_turns: 42, duration_ms: 125000, total_cost_usd: 1.234 }));
  assert.equal(ok, "finished (success), 42 turns, 125s, ~$1.23 (estimate)");
  // Another provider's model: Claude Code's estimate is at Claude prices, so it is left out.
  assert.equal(summarizeStreamLine(line({ type: "result", subtype: "success", num_turns: 42, duration_ms: 125000, total_cost_usd: 26.36 }), { cost: false }),
    "finished (success), 42 turns, 125s");
  assert.doesNotMatch(ok, /critical flaw/);
  const bad = summarizeStreamLine(line({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 402 would exceed your available credits", num_turns: 1, duration_ms: 3000 }));
  assert.equal(bad, "ended with an error, 1 turns, 3s");
});

test("a denied tool call is reported by tool name", () => {
  assert.equal(
    summarizeStreamLine(line({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "Permission to use Bash has been denied. IMPORTANT: ..." })),
    "permission denied for Bash");
});

test("control characters cannot break the line or forge a workflow command", () => {
  const summary = summarizeStreamLine(line({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a\n::error::forged\r\nb" } }] },
  }));
  assert.ok(!/[\r\n]/.test(summary));
  assert.ok(summary.startsWith("Read"));
});

test("long targets are cut and non-JSON is ignored", () => {
  const summary = summarizeStreamLine(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "x".repeat(1000) } }] } }));
  assert.ok(summary.length < 200);
  assert.equal(summarizeStreamLine("Warning: something on stdout"), null);
  assert.equal(summarizeStreamLine("42"), null);
  assert.equal(summarizeStreamLine("null"), null);
});

test("Grep patterns and free-form errors are not disclosed", () => {
  const events = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "sensitive-value" } }] } },
    { type: "system", subtype: "api_retry", error: "sensitive-value", error_status: 401 },
    { type: "result", is_error: true, result: "sensitive-value" },
  ];
  for (const event of events) assert.doesNotMatch(summarizeStreamLine(line(event)), /sensitive-value/);
  assert.equal(summarizeStreamLine(line(events[0])), "Grep");
});
