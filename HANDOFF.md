# HANDOFF: security-review

Handoff from a Claude chat (2026-09-28/29) to Claude Code. Read this first, then the files it names.

## Goal

Replace a manual routine: opening Codex, Claude Code and Gemini Antigravity separately, pasting
"do a security review of this repo and open a PR with fixes and findings", and waiting (last done
on the **Sandfort** repo). The replacement is a script plus a GitHub workflow that run all three
agents headlessly with **API keys** (not subscriptions). Each agent opens its own PR.

## What's in this folder

| Path | What it is |
|---|---|
| `scripts/security-review.mjs` | The tool. Node 18+, zero dependencies. Runs `claude`, `codex`, `gemini` CLIs in parallel, each in its own git worktree off `origin/<base>`. Each writes `.security-review.md`, then the script commits fixes and the report, pushes `security-review/<agent>-<YYYYMMDD-HHMM>` and runs `gh pr create`. |
| `.github/workflows/security-review.yml` | **Reusable** workflow (`workflow_call`). Plan job turns the provider booleans into a matrix and skips providers whose secret is missing. The review job checks out the caller repo, sparse-checks-out this repo's `scripts/` into `.security-review-tool/`, installs the one CLI it needs and runs the script with `AGENTS=<one agent>`. |
| `examples/caller.yml` | Copy into any repo as `.github/workflows/security-review.yml`. `workflow_dispatch` only, with checkboxes for Anthropic / OpenAI / Gemini plus draft. `secrets: inherit`. |
| `README.md` | Short user-facing description. |
| `extras/security-review.sh` | Earlier **bash** version of the script (superseded by the `.mjs`; same behaviour, stub-tested). Reference only. |
| `extras/single-repo-workflow.yml` | Earlier **non-reusable** workflow that expects the script at `.github/scripts/security-review.mjs` in the same repo. Superseded by the reusable workflow plus `examples/caller.yml`. |

## Decisions already made (don't relitigate without reason)

- **Shell out to the vendors' own agent CLIs** instead of calling LLM APIs directly. This matches what the user did manually.
- **Gemini CLI stands in for Antigravity.** Antigravity is a desktop app and can't be scripted.
- **One PR per agent.** There is no cross-model dedup or consensus merge. That was discussed as a possible later add-on; the user chose the simple version.
- **The workflow runs our script, not the vendor GitHub Actions** (`anthropics/claude-code-action`, `openai/codex-action`, `google-github-actions/run-gemini-cli`). Their commit behaviour differs, and Gemini's action didn't document a version tag or how to allow edits. Using the script keeps one prompt and identical local/CI behaviour.
- **On demand only.** The user asked to remove the `schedule:` trigger.
- **Any combination of the 3 providers** is selectable per run.
- **Claude Code's allowed tools are `Read,Edit,Write,Glob,Grep`** (no Bash, so it can't run tests). This was deliberate for unattended safety. Codex uses `exec --full-auto` (workspace-write sandbox). Gemini uses `--approval-mode auto_edit`.
- **Reusable workflow plus central repo:** a reusable workflow checks out the *caller's* repo, so the script must be fetched from the central repo (`tool-repository` / `tool-ref` inputs).

## Verified so far

- Script: run end to end with stub `claude`/`codex`/`gemini`/`gh` binaries against a local bare git remote. Covered a fix plus report giving a PR, a report-only PR, an agent failure skipped without blocking the others, the prompt passing through intact as a raw argument, `DRAFT=0`, and worktree cleanup.
- Both workflows pass **actionlint 1.7.7**, including the caller linted against the reusable workflow via a local path.
- The plan job's selection logic was tested for every checkbox/secret combination, including none selected and selected without a key.

## Resolved in Claude Code (2026-09-29)

- **Windows:** `resolveBin()` uses a `.exe` directly. For an npm `.cmd` shim it parses the shim's
  `"%dp0%\...js"` target and runs it with `process.execPath`, with no shell. Tested on Windows 11 / Node 22.15 against
  the real `@google/gemini-cli` 0.61.0 shim (prompt with `" & | ^ %` passed intact). A full end-to-end run through a
  stub `.cmd` agent and a local bare remote pushed the branch, the commit and the report; `gh pr create` failed as expected on a non-GitHub remote. A shim that can't be parsed
  now skips that agent instead of aborting the run.
- **CLI flags checked with `--help`:** claude 2.1.260 is OK as written. **codex 0.153/0.158 removed `--full-auto`**, so
  it's now `codex exec --sandbox workspace-write`. gemini 0.61.0 is OK, and `--skip-trust` was added because each
  worktree is a fresh untrusted folder.
- **Repo name** is `shaztechio/multi-llm-security-review` (updated in both workflows).
- `extras/security-review.sh` still has `--full-auto`. It's reference-only and wasn't updated.

## NOT verified (do these first)

1. **No real agent run yet** (flags are confirmed, but no agent has run with a real API key).
2. **Never run on GitHub Actions.** Watch for Codex's Linux sandbox on hosted runners, the Gemini CLI needing a
   TTY, and `gh pr create` permissions.
3. Workflows weren't re-linted after the repo-name change (actionlint isn't installed locally; the change is a string only).

## Suggested next steps

1. Push this repo (public; it holds no secrets).
2. Run locally on a throwaway branch of Sandfort:
   `AGENTS=claude node scripts/security-review.mjs ~/path/to/sandfort`, then add codex, then gemini.
3. Add `examples/caller.yml` to Sandfort, set the secrets, enable "Allow GitHub Actions to create and approve
   pull requests", then run once from the Actions tab.
4. Once it works, tag `v1` and pin the caller's `uses: ...@v1` **and** `tool-ref: v1` together.

## Known caveats / possible later work

- PRs opened with `GITHUB_TOKEN` don't trigger other workflows (e.g. tests). Fix with a GitHub App token or a PAT.
- **Public repos:** a PR listing unfixed vulnerabilities is public immediately. Use this on private repos, or
  route reports elsewhere.
- Cost scales with repo size × 3 agents. There's no global budget cap; the only cap is `AGENT_TIMEOUT_MIN` (default 60).
- The report is truncated to 60k chars in the PR body; the full report is committed under `security-reviews/`.
- Idea not built: an optional **VVAH** lane (github.com/visa/visa-vulnerability-agentic-harness). It's a deeper
  11-stage pipeline, Claude-based with no Gemini support, and doesn't open PRs. Wrap `vvaharness scan`/`remediate` as another
  agent in `AGENT_DEFS` and reuse the commit/PR step. Run `vvaharness estimate` first for cost.
- Idea not built: a cross-model consensus report (dedup findings by file/line/CWE, score by agreement).

## Alternatives already evaluated (and why not)

- **Strix**: strong whole-repo pentest agent (LiteLLM, any provider), but the OSS CLI doesn't open PRs; autofix PRs are cloud-only.
- **fonCki/secure-review**: multi-model (Anthropic/OpenAI/Google) with a fix loop, but no PR creation, a JS-centric SAST layer, and 0 stars.
- **Argus (argus-appsec)**: opens PRs, but no Gemini and mostly static scanners.
- **parallel-code / wmux / claude-octopus**: interactive desktop or TUI apps, not scriptable.
- **autoagent-action**: multi-agent, but comments only, no fixes or PRs, and experimental.
- **anthropics/claude-code-security-review**: Claude-only, reviews PR diffs.
- **Supply chain note:** LiteLLM 1.82.7/1.82.8 were compromised. This matters for Strix/OpenHands-style tools; our tool doesn't use LiteLLM.
