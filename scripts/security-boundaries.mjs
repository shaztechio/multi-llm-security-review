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

// Trust boundaries between the publisher (this script, which holds a write token) and the agents (which
// read a repository they did not write). Kept apart from security-review.mjs so they can be tested.

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Never given to an agent: the tokens that can push and open PRs, and the ones that reach GitHub's artifact
// and OIDC services.
const PUBLISHER_VARS = [
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
];

// Provider credentials, grouped under the key of the agent that owns them.
const PROVIDER_VARS = {
  ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  OPENAI_API_KEY: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  OPENROUTER_API_KEY: ["OPENROUTER_API_KEY"],
  GEMINI_API_KEY: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

// The environment for one agent subprocess: the parent's, minus the publisher's tokens and every provider's
// credentials except the agent's own (`key`), then `extra` on top. Names are compared case-insensitively
// because Windows environment names are, and `{ ...process.env }` keeps whatever case they were set in.
// The parent object is not modified. This is not isolation: credential files, an SSH agent or operator-defined
// secrets in other variables are still reachable.
export function agentEnvironment(parent, key, extra = {}) {
  const own = key.toUpperCase();
  const strip = new Set(PUBLISHER_VARS);
  for (const vars of Object.values(PROVIDER_VARS)) for (const v of vars) strip.add(v);
  for (const v of PROVIDER_VARS[own] ?? []) strip.delete(v);
  strip.delete(own);
  const child = Object.fromEntries(Object.entries(parent).filter(([name]) => !strip.has(name.toUpperCase())));
  return { ...child, ...extra };
}

// Create (if needed) and return the directory the report is committed under, refusing anything that would
// put it outside the worktree. `directory` comes from REPORT_DIR, and the worktree from a repository whose
// contents are untrusted: it can ship `security-reviews` as a symlink, and mkdir/rename would follow it and
// write outside the worktree. Every component must already be a real directory or be created here.
export function reportDirectory(worktree, directory) {
  const root = realpathSync(worktree);
  const destination = resolve(root, directory);
  const path = relative(root, destination);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("REPORT_DIR must be a directory inside the worktree");
  }
  let current = root;
  for (const component of path.split(sep)) {
    current = join(current, component);
    try {
      if (!lstatSync(current).isDirectory()) throw new Error("REPORT_DIR must not contain symbolic links or files");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current);
    }
  }
  return destination;
}
