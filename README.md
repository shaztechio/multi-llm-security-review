# multi-llm-security-review

A reusable GitHub Actions workflow that runs **Claude Code** and **Codex** (and, opt-in, an
**OpenRouter** model) against a repo. Each agent reviews the whole codebase for security issues, fixes what it is confident about, and
opens its own PR with the fixes and a findings report. One PR per agent; there is no cross-model merge.
Findings are also uploaded as SARIF to the repo's code scanning alerts, which only collaborators can see.

The same script also runs locally, so CI and local runs behave identically.

| Path | What it is |
|---|---|
| `.github/workflows/security-review.yml` | The reusable workflow (`workflow_call`). One matrix job per selected provider. |
| `examples/caller.yml` | Copy into a repo to get a "Run workflow" button with provider checkboxes. |
| `scripts/security-review.mjs` | The tool. Node 18+, no dependencies. The workflow fetches it from this repo. |
| `.github/workflows/no-secrets.yml` | Guard that fails if this repo can see any provider API key. |
| `extras/` | Earlier bash script and single-repo workflow. Superseded, kept for reference only. |
| `LICENSE` | Apache License 2.0. |

## Use it from another repo

1. Copy [`examples/caller.yml`](examples/caller.yml) to `.github/workflows/security-review.yml` in the repo
   you want reviewed.
2. In that repo, add a secret for each provider you'll use (see [API keys](#api-keys)).
3. In that repo, enable Settings → Actions → General → **Allow GitHub Actions to create and approve pull requests**.
4. Actions tab → **Security review** → **Run workflow**, tick the providers, run.

Each selected agent opens a PR on a `security-review/<agent>-<YYYYMMDD-HHMM>` branch. Its report is
committed under `security-reviews/` and included in the PR body, truncated to 60k characters. Its
findings are also uploaded to code scanning (see [Code scanning](#code-scanning)).

The workflow runs on demand only (`workflow_dispatch`). The caller grants `contents: write` and
`pull-requests: write`, plus `security-events: write` and `actions: read` for the code scanning upload.
If you copied an older `caller.yml`, add those two permissions and the `upload-sarif` input.

### Inputs

| Input | Default | Notes |
|---|---|---|
| `anthropic` / `openai` | `true` | Which agents to run. |
| `openrouter` | `false` | Also run an OpenRouter model (experimental, see [OpenRouter](#openrouter)). |
| `openrouter-model` | `z-ai/glm-5.3` | OpenRouter model slug. |
| `openrouter-max-output-tokens` | `16000` | Output cap per request. OpenRouter reserves credit from it, so lower needs less balance. |
| `openrouter-max-context-tokens` | Claude Code's 200k | The model's real context window, if you know it. Do not raise it to 1M to "use" a big window: turns get more expensive. |
| `openrouter-auto-compact-window` | `100000` | Compact the conversation at this many tokens (100000 to 1000000). Every turn re-sends it, so smaller is cheaper. |
| `openrouter-max-turns` | none | Stop after this many turns. Reaching it fails the run, with no PR if the report was not written yet. |
| `stream-logs` | `false` | One progress line per tool call in the job log, for the Claude and OpenRouter agents. See [Live progress](#live-progress). |
| `draft` | `true` | Open PRs as drafts. |
| `upload-sarif` | `true` | Upload findings to code scanning. Untick on private repos without GitHub Code Security. |
| `base-branch` | repo default | Branch to review and target. |
| `claude-model` / `codex-model` | CLI default | Model override per agent. |
| `codex-effort` | `medium` | Codex reasoning effort. |
| `agent-timeout-minutes` | `60` | Kills an agent that runs longer. Keep under 105 (the job limit is 120). |
| `tool-repository` / `tool-ref` | this repo / `main` | Where the script is fetched from. Keep `tool-ref` in step with the `@ref` on the `uses:` line. |

To pin a release, set both `uses: shaztechio/multi-llm-security-review/.github/workflows/security-review.yml@1.0.0`
**and** `tool-ref: 1.0.0`.

## API keys

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and/or `OPENROUTER_API_KEY` as secrets **in each calling repo**
(only for the providers you tick). They reach the workflow through `secrets: inherit`.

Never add them to this repo:

- `no-secrets.yml` fails if this repo can see any of them, including org secrets shared with it. It runs on
  every push and PR, and weekly. If you use org secrets, share them only with selected repos and leave
  this one out.
- The reusable workflow refuses to run from this repo.
- A run fails if a ticked provider has no key.

Keep this repo public (it contains no secrets), or grant callers access under
Settings → Actions → General → Access.

## Code scanning

Each agent also writes its findings (fixed or not) as SARIF. The workflow uploads them to the calling
repo's **Security → Code scanning** page, one category per agent (`security-review-claude` and so on),
attached to the reviewed branch and commit.

- Alerts are visible only to people with write or security access, not the public.
- Free on public repos. Private repos need a GitHub Code Security license; without one, untick
  `upload-sarif` or the upload step fails.
- The SARIF is never committed to the PR.
- Alerts close when a later run of the same agent no longer reports them, so run again after merging fixes.
- Before upload, the script tidies what the agent wrote: paths made repo-relative, a line number on
  every location, and findings without a file location dropped.

## How each agent runs

Each agent works in its own git worktree off `origin/<base>` and writes `.security-review.md` and
`.security-review.sarif`. The script moves the SARIF out of the worktree, then commits the fixes and the
report, pushes, and runs `gh pr create`. Agents never commit or push themselves.

| Agent | Command | Permissions |
|---|---|---|
| Claude Code | `claude -p … --permission-mode acceptEdits --allowedTools Read,Edit,Write,Glob,Grep` | Edits only, no shell (so it can't run tests). |
| Codex | `openai/codex-action` (`:workspace` profile, `drop-sudo`) | Workspace-write sandbox; the action sets up user namespaces on GitHub runners. |
| OpenRouter | `claude -p …` with `ANTHROPIC_BASE_URL=https://openrouter.ai/api` | Same as Claude Code. Opt-in; see below. |

Gemini CLI was removed: its model refused to do vulnerability review of a repository, even when framed defensively.

## OpenRouter

Opt-in and experimental. Tick `openrouter` and optionally set `openrouter-model` (default `z-ai/glm-5.3`) to run
that model through Claude Code, pointed at OpenRouter's Anthropic-compatible endpoint with the same
edit-only tools. The PR, branch and code scanning category are named `openrouter`. One model per run.

- The model must support tool use. If it doesn't write a report with a Coverage section, no PR is opened.
- Use an OpenRouter key with a spend limit; there is no budget cap here.
- Add the `:floor` suffix to the model slug you choose (for example `z-ai/glm-5.3:floor`) and OpenRouter routes
  to the cheapest provider for that model.
- **Cost is mostly input tokens.** An agent re-sends its whole conversation every turn, so a whole-repo review is
  millions of input tokens and only tens of thousands of output tokens. The estimate Claude Code prints is at
  Claude's prices, not the model's. Caching is what brings input down (Z.AI reads cost about a fifth), and it only
  hits when each turn goes to the same provider: the agent sends a per-run `x-session-id` for that. Check the
  Activity page of your OpenRouter account for `cached_tokens` per request. In your account's privacy settings you
  can also allow only the provider whose cache you want.
- OpenRouter answers `402 … would exceed your available credits` when a request's reserved cost (output cap
  times price, plus requests in flight) is more than the balance. Add credits, or lower `openrouter-max-output-tokens`.
- Claude Code does not recognise most OpenRouter model ids and warns `unrecognized_model`; it then assumes a
  200k context window. That is harmless, and `openrouter-max-context-tokens` corrects it.
- Not yet verified against every Claude Code release. Existing agents are unaffected.
- Locally: `AGENTS=openrouter OPENROUTER_API_KEY=... OPENROUTER_MODEL=vendor/model node scripts/security-review.mjs`.

## Live progress

By default an agent's own output goes to a file (uploaded as the `security-review-<agent>-log` artifact), so the
job log shows only `[agent] reviewing…` until the end. Tick `stream-logs` (or set `STREAM_LOGS=1` locally) to run
Claude Code with `--output-format stream-json --verbose` and print one line per tool call for the `claude` and
`openrouter` agents, for example `[openrouter] Read apps/dotnet/src/Core/BackupManager.cs`, plus API retries and a
final line with turns, time and cost. Codex already prints live through its action.

- **Only the tool and the path or pattern it was pointed at are printed.** Never the model's text, its reasoning, tool
  results or file contents, so unfixed findings do not appear in a public job log as they are made. The full stream
  still goes to the agent's log file.
- Off by default. `--output-format stream-json --verbose` changes only what Claude Code prints, not what it sends.
- The cost Claude Code reports is an estimate at Claude's prices, so it is shown only for the `claude` agent.

## Run locally

Requires Node 18+, git, an authenticated `gh`, and the CLIs you want to run
(`npm i -g @anthropic-ai/claude-code @openai/codex`). Works on Windows, macOS and Linux.

```bash
AGENTS=claude ANTHROPIC_API_KEY=... node scripts/security-review.mjs path/to/repo
```

The wrapper scripts check the prerequisites and your keys, then call the same script. They read keys
from the environment or a git-ignored `.env` (copy [`.env.example`](.env.example); variables already
set in your shell win). `AGENTS` defaults to `claude openrouter`, and `OPENROUTER_MAX_TURNS` to `60`.
`PATH`, `HOME`, `NODE_*`, `GIT_*`, `LD_*`, `DYLD_*` and shell-startup variables are ignored in `.env`
(with a warning), since a `.env` from someone else could otherwise run code; set them in your shell.
Pass `-h` / `--help` for usage.

```bash
scripts/run-local.sh [repo-path]        # Linux, macOS
```

```powershell
.\scripts\run-local.ps1 [repo-path]     # Windows PowerShell
```

| Env var | Default | Notes |
|---|---|---|
| `AGENTS` | `claude codex` | Space-separated. Agents without a CLI or key are skipped. |
| `BASE_BRANCH` | origin's default branch | |
| `CLAUDE_MODEL` / `CODEX_MODEL` | CLI default | |
| `OPENROUTER_MODEL` | `z-ai/glm-5.3` | Model for the `openrouter` agent (which is not in the default `AGENTS`). |
| `OPENROUTER_AUTO_COMPACT_WINDOW` / `OPENROUTER_MAX_TURNS` | `100000` / none | Passed to Claude Code as `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `--max-turns`. |
| `OPENROUTER_MAX_OUTPUT_TOKENS` / `OPENROUTER_MAX_CONTEXT_TOKENS` | `16000` / unset | Passed to Claude Code as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. |
| `DRAFT` | `1` | `0` for ready-for-review PRs. |
| `PR_TITLE_PREFIX` | `fix(security)` | PR titles and commits read `<prefix>: apply <agent> security review findings`, so repos that check Conventional Commit titles accept them. |
| `REPORT_DIR` | `security-reviews` | Where the report is committed. |
| `AGENT_TIMEOUT_MIN` | `60` | |
| `SARIF_DIR` | the run's temp dir | Where `<agent>.sarif` is written. |

Agent logs are kept in a `secreview-*` temp directory, printed at the end. In CI they're uploaded as
the `security-review-<agent>-log` artifact.

Agent subprocesses get only their own provider's credentials, not the GitHub tokens or other providers'
keys. That is environment filtering, not isolation: credential files, an SSH agent and other secrets you
put in the environment are still reachable. `REPORT_DIR` must stay inside the worktree and is refused if
any part of it is a symbolic link.

Local runs write the SARIF but don't upload it. To upload one by hand (needs `security-events` access):

```bash
gh api repos/OWNER/REPO/code-scanning/sarifs -f commit_sha=$(git rev-parse origin/main) -f ref=refs/heads/main -f sarif=$(gzip -c claude.sarif | base64 -w0)
```

## Caveats

- **Public repos:** a PR listing unfixed vulnerabilities is public as soon as it opens, and so are the
  agent log artifacts. Code scanning alerts stay private, but the PRs don't; use this on private repos.
- PRs opened with `GITHUB_TOKEN` don't trigger other workflows (e.g. tests). Use a GitHub App token or a
  PAT if you need that.
- Cost scales with repo size × number of agents. There is no budget cap; only the per-agent timeout.

## License

Copyright 2026 Shazron Abdullah. Licensed under the [Apache License, Version 2.0](LICENSE).
Each source file carries the standard Apache-2.0 header with `SPDX-License-Identifier: Apache-2.0`.
