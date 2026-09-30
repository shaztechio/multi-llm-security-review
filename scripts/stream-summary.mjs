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

// Turns one line of `claude -p --output-format stream-json --verbose` into a short progress line for the
// job log, or null to print nothing.
//
// Deliberately narrow, because the job log of a public repository is public and a review is about
// unfixed vulnerabilities: it names the tool and the path or pattern it was pointed at, and never the
// model's text, its reasoning, tool results or file contents. The full stream still goes to the agent's
// log file (the workflow uploads it as an artifact).

const MAX = 160;

const clean = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ") // one line, no control characters
    .trim()
    .slice(0, MAX);

// The path, pattern or command-free argument a tool call was aimed at.
function target(input) {
  if (!input || typeof input !== "object") return "";
  return clean(input.file_path ?? input.path ?? input.pattern ?? "");
}

export function summarizeStreamLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null; // not JSON (a warning on stdout, say): leave it to the log file
  }
  if (!event || typeof event !== "object") return null;

  if (event.type === "system") {
    if (event.subtype === "init") {
      const tools = Array.isArray(event.tools) ? event.tools.length : "?";
      return `session started (model ${clean(event.model) || "?"}, ${tools} tools)`;
    }
    if (event.subtype === "api_retry") {
      const status = event.error_status == null ? "no response" : `HTTP ${event.error_status}`;
      return `API retry ${event.attempt}/${event.max_retries}: ${clean(event.error) || "unknown"} (${status}), next in ${Math.round((event.retry_delay_ms ?? 0) / 1000)}s`;
    }
    return null;
  }

  if (event.type === "assistant") {
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) return null;
    const calls = blocks
      .filter((b) => b?.type === "tool_use")
      .map((b) => [clean(b.name), target(b.input)].filter(Boolean).join(" "));
    return calls.length ? calls.join("; ") : null;
  }

  if (event.type === "result") {
    const parts = [event.is_error ? `finished with an error (${clean(event.subtype)})` : `finished (${clean(event.subtype) || "success"})`];
    if (event.num_turns != null) parts.push(`${event.num_turns} turns`);
    if (event.duration_ms != null) parts.push(`${Math.round(event.duration_ms / 1000)}s`);
    if (typeof event.total_cost_usd === "number") parts.push(`~$${event.total_cost_usd.toFixed(2)}`);
    // On an error the result is the failure message (a 402, an auth error); on success it is the model's
    // own summary, which stays out of the log.
    if (event.is_error && event.result) parts.push(clean(event.result));
    return parts.join(", ");
  }

  return null;
}
