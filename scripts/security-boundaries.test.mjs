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

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentEnvironment, reportDirectory } from "./security-boundaries.mjs";

const parent = {
  PATH: "runtime", GH_TOKEN: "publisher", github_token: "publisher", ACTIONS_RUNTIME_TOKEN: "artifact",
  ANTHROPIC_API_KEY: "claude", ANTHROPIC_AUTH_TOKEN: "claude-auth",
  OPENAI_API_KEY: "openai", CODEX_API_KEY: "openai-codex", OPENROUTER_API_KEY: "router", GOOGLE_API_KEY: "google",
};

test("each agent keeps only its own provider credentials", () => {
  assert.deepEqual(agentEnvironment(parent, "ANTHROPIC_API_KEY"),
    { PATH: "runtime", ANTHROPIC_API_KEY: "claude", ANTHROPIC_AUTH_TOKEN: "claude-auth" });
  assert.deepEqual(agentEnvironment(parent, "OPENAI_API_KEY"),
    { PATH: "runtime", OPENAI_API_KEY: "openai", CODEX_API_KEY: "openai-codex" });
  // The openrouter agent's extra env replaces Claude's variables, and nothing of Claude's leaks in first.
  assert.deepEqual(
    agentEnvironment(parent, "OPENROUTER_API_KEY", { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "router" }),
    { PATH: "runtime", OPENROUTER_API_KEY: "router", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "router" });
});

test("publisher tokens are removed whatever their case, and the parent is not modified", () => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    const child = agentEnvironment(parent, key);
    assert.equal(Object.keys(child).some((n) => /^(gh_token|github_token|actions_runtime_token)$/i.test(n)), false);
  }
  assert.equal(parent.GH_TOKEN, "publisher");
  assert.equal(parent.github_token, "publisher");
});

test("an agent's own key is kept even if its name is not a known provider", () => {
  assert.deepEqual(agentEnvironment({ PATH: "p", NEWAGENT_KEY: "k", OPENAI_API_KEY: "o" }, "NEWAGENT_KEY"),
    { PATH: "p", NEWAGENT_KEY: "k" });
});

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "security-boundaries-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  return { root, worktree };
}

test("the report directory is created inside the worktree, nested or not", (context) => {
  const { worktree } = fixture(context);
  assert.equal(reportDirectory(worktree, "security-reviews"), join(worktree, "security-reviews"));
  assert.equal(reportDirectory(worktree, "reports/nested"), join(worktree, "reports", "nested"));
  assert.equal(reportDirectory(worktree, "reports/nested"), join(worktree, "reports", "nested")); // already there
});

test("a report directory outside the worktree is refused", (context) => {
  const { root, worktree } = fixture(context);
  for (const directory of ["..", "../outside", "a/../../outside", root, ".", ""]) {
    assert.throws(() => reportDirectory(worktree, directory), /inside the worktree/, directory);
  }
});

test("a file where a directory should be is refused", (context) => {
  const { worktree } = fixture(context);
  writeFileSync(join(worktree, "file"), "report");
  assert.throws(() => reportDirectory(worktree, "file/nested"), /symbolic links or files/);
});

test("a committed symlink to a directory elsewhere is refused", (context) => {
  const { root, worktree } = fixture(context);
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(worktree, "security-reviews"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => reportDirectory(worktree, "security-reviews"), /symbolic links or files/);
  assert.throws(() => reportDirectory(worktree, "security-reviews/nested"), /symbolic links or files/);
});
