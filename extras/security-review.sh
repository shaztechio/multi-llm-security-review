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

# security-review.sh — run Claude Code, Codex and Gemini CLI headlessly against a repo,
# each in its own git worktree, and open one draft PR per agent with fixes + findings.
#
# Usage:  ./security-review.sh [path/to/repo]            (default: current dir)
#
# Requires: git, gh (authenticated), and whichever agent CLIs you want to run:
#   claude  (npm i -g @anthropic-ai/claude-code)   needs ANTHROPIC_API_KEY
#   codex   (npm i -g @openai/codex)               needs OPENAI_API_KEY
#   gemini  (npm i -g @google/gemini-cli)          needs GEMINI_API_KEY
#
# Optional env:
#   AGENTS="claude codex gemini"   which agents to run
#   BASE_BRANCH=main               branch to review (default: origin's default branch)
#   CLAUDE_MODEL / CODEX_MODEL / GEMINI_MODEL   override each agent's model
#   REPORT_DIR=security-reviews    where the findings file is committed in the PR
#   DRAFT=1                        open PRs as drafts (0 to disable)

set -euo pipefail

REPO="$(cd "${1:-.}" && git rev-parse --show-toplevel)"
AGENTS="${AGENTS:-claude codex gemini}"
REPORT_DIR="${REPORT_DIR:-security-reviews}"
DRAFT="${DRAFT:-1}"
STAMP="$(date +%Y%m%d-%H%M)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/secreview-$STAMP-XXXX")"
REPORT_FILE=".security-review.md"   # agents write here, inside their worktree

cd "$REPO"
git fetch --quiet origin
BASE_BRANCH="${BASE_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')}"
BASE_BRANCH="${BASE_BRANCH:-main}"

gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated (run: gh auth login)"; exit 1; }

read -r -d '' PROMPT <<EOF || true
You are performing a security review of this repository.

1. Review the whole codebase for security vulnerabilities: injection, authn/authz flaws,
   secrets in code, unsafe deserialization, path traversal, SSRF, insecure crypto,
   dependency risks, insecure defaults, and anything else you find.
2. Fix every finding you are confident about, with minimal, focused changes that keep
   existing behaviour and tests intact. Do not refactor unrelated code.
3. Write your findings to ./${REPORT_FILE} in Markdown with:
   - a one-paragraph summary
   - a table: ID | Severity (Critical/High/Medium/Low) | File:line | Issue | Status (Fixed / Not fixed)
   - for each finding: description, impact, and either what you changed or why you left it
Do not run git commit, git push, or create branches or pull requests; that is handled for you.
EOF

preflight() {
  local agent="$1" bin key
  case "$agent" in
    claude) bin=claude; key=ANTHROPIC_API_KEY ;;
    codex)  bin=codex;  key=OPENAI_API_KEY ;;
    gemini) bin=gemini; key=GEMINI_API_KEY ;;
    *) echo "[$agent] unknown agent, skipping"; return 1 ;;
  esac
  command -v "$bin" >/dev/null || { echo "[$agent] '$bin' not installed, skipping"; return 1; }
  [[ -n "${!key:-}" ]]        || { echo "[$agent] $key not set, skipping"; return 1; }
}

run_cli() {
  local agent="$1"
  case "$agent" in
    claude)
      claude -p "$PROMPT" \
        --permission-mode acceptEdits \
        --allowedTools "Read,Edit,Write,Glob,Grep" \
        ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"} ;;
    codex)
      CODEX_API_KEY="$OPENAI_API_KEY" codex exec --full-auto \
        ${CODEX_MODEL:+--model "$CODEX_MODEL"} "$PROMPT" ;;
    gemini)
      gemini -p "$PROMPT" --approval-mode auto_edit \
        ${GEMINI_MODEL:+--model "$GEMINI_MODEL"} ;;
  esac
}

run_agent() {
  local agent="$1"
  local branch="security-review/${agent}-${STAMP}"
  local wt="$RUN_DIR/$agent"
  local log="$RUN_DIR/$agent.log"

  echo "[$agent] reviewing (log: $log)"

  if ! (cd "$wt" && run_cli "$agent") >"$log" 2>&1; then
    echo "[$agent] agent exited with an error; see $log"
  fi

  cd "$wt"
  # -L first: a symlink left here would be moved into the repo as the report and its target read
  # into the PR body, disclosing a file from outside the worktree to everyone who can see the PR.
  if [[ -L "$REPORT_FILE" || ! -f "$REPORT_FILE" || ! -s "$REPORT_FILE" ]]; then
    echo "[$agent] no usable findings report written; skipping PR (see $log)"
    return 0
  fi

  mkdir -p "$REPORT_DIR"
  local committed_report="$REPORT_DIR/${STAMP}-${agent}.md"
  mv "$REPORT_FILE" "$committed_report"

  git add -A
  local fixed_files
  fixed_files="$(git diff --cached --name-only | grep -vc "^$REPORT_DIR/" || true)"
  git commit --quiet -m "Security review ($agent): findings and fixes"
  git push --quiet -u origin "$branch"

  local body="$RUN_DIR/$agent-body.md"
  {
    echo "Automated security review by **$agent** against \`$BASE_BRANCH\`."
    echo "Files changed by fixes: **$fixed_files**. Full report: \`$committed_report\`."
    echo
    head -c 60000 "$committed_report"
  } >"$body"

  local pr_args=(--base "$BASE_BRANCH" --head "$branch")
  [[ "$DRAFT" == 1 ]] && pr_args+=(--draft)
  local url
  url="$(gh pr create "${pr_args[@]}" \
          --title "Security review ($agent) — $STAMP" \
          --body-file "$body")"
  echo "[$agent] PR opened: $url"
}

# Create worktrees one at a time (parallel `git worktree add` races on git's lock),
# then run the agents in parallel.
ready=()
for agent in $AGENTS; do
  preflight "$agent" || continue
  git worktree add --quiet -b "security-review/${agent}-${STAMP}" "$RUN_DIR/$agent" "origin/$BASE_BRANCH"
  ready+=("$agent")
done
[[ ${#ready[@]} -gt 0 ]] || { echo "No agents could run."; exit 1; }

pids=()
for agent in "${ready[@]}"; do
  run_agent "$agent" &
  pids+=($!)
done
[[ ${#pids[@]} -gt 0 ]] || { echo "No agents could run."; exit 1; }
for pid in "${pids[@]}"; do wait "$pid" || true; done

cd "$REPO"
for agent in $AGENTS; do
  [[ -d "$RUN_DIR/$agent" ]] && git worktree remove --force "$RUN_DIR/$agent" || true
done
echo "Done. Logs kept in $RUN_DIR"
