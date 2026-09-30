#!/usr/bin/env bash
# Copyright 2026 Shazron Abdullah
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Local runner for security-review.mjs (Linux/macOS). Usage: scripts/run-local.sh [repo-path]
# Keys come from your environment or a git-ignored .env file (see .env.example) at the repo root,
# or the file named by SECREVIEW_ENV_FILE. Variables already set in your shell win over the file.
# AGENTS defaults to "claude openrouter"; override with e.g. AGENTS="claude codex".

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/run-local.sh [-h|--help] [repo-path]

Runs scripts/security-review.mjs on repo-path (default: this repo). Each agent reviews the
code, fixes what it is confident about, pushes a branch and opens a draft PR.

Keys are read from the environment, or from a git-ignored .env file at the repo root
(see .env.example). Variables already set in your shell win over the file. PATH, HOME, NODE_*,
GIT_*, LD_*, DYLD_* and shell-startup variables are ignored in the file.

Environment:
  ANTHROPIC_API_KEY     needed for agent "claude"
  OPENROUTER_API_KEY    needed for agent "openrouter"
  OPENAI_API_KEY        needed for agent "codex"
  AGENTS                space-separated agents (default: "claude openrouter")
  OPENROUTER_MAX_TURNS  turn cap for openrouter (default: 60)
  SECREVIEW_ENV_FILE    use this env file instead of <repo>/.env

Any other variable documented in the README (BASE_BRANCH, DRAFT, ...) is passed through.

Examples:
  scripts/run-local.sh
  AGENTS="claude codex" scripts/run-local.sh ../other-repo
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-$here/..}"

env_file="${SECREVIEW_ENV_FILE:-$here/../.env}"
if [[ -f "$env_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    # A .env can arrive from elsewhere (a teammate, a cloned repo); these would turn it into code
    # execution in the node/git/gh children, so they can only come from your own shell.
    case "$k" in
      PATH|HOME|IFS|ENV|BASH_ENV|SHELLOPTS|PS4|PROMPT_COMMAND|NODE_*|LD_*|DYLD_*|GIT_*)
        echo "ignoring $k in $env_file (set it in your shell if you mean it)" >&2; continue ;;
    esac
    v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
    [[ -n "${!k:-}" ]] || export "$k=$v"
  done < "$env_file"
fi

for cmd in node git gh; do
  command -v "$cmd" >/dev/null || { echo "missing: $cmd" >&2; exit 1; }
done
gh auth status >/dev/null || { echo "gh is not authenticated (run: gh auth login)" >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
  || { echo "Node 18+ required" >&2; exit 1; }

export AGENTS="${AGENTS:-claude openrouter}"
export OPENROUTER_MAX_TURNS="${OPENROUTER_MAX_TURNS:-60}"

for a in $AGENTS; do
  case "$a" in
    claude)     [[ -n "${ANTHROPIC_API_KEY:-}"  ]] || { echo "ANTHROPIC_API_KEY not set" >&2; exit 1; } ;;
    openrouter) [[ -n "${OPENROUTER_API_KEY:-}" ]] || { echo "OPENROUTER_API_KEY not set" >&2; exit 1; } ;;
    codex)      [[ -n "${OPENAI_API_KEY:-}"     ]] || { echo "OPENAI_API_KEY not set" >&2; exit 1; } ;;
  esac
done

exec node "$here/security-review.mjs" "$target"
