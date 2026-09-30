#!/usr/bin/env node
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

// security-review.mjs — run Claude Code and Codex headlessly against a repo,
// each in its own git worktree, and open one draft PR per agent with fixes + findings.
//
// Usage:  node security-review.mjs [path/to/repo]          (default: current dir)
//
// Requires Node 18+, git, gh (authenticated), and whichever agent CLIs you want to run:
//   claude  (npm i -g @anthropic-ai/claude-code)   needs ANTHROPIC_API_KEY
//   codex   (npm i -g @openai/codex)               needs OPENAI_API_KEY
//   openrouter  runs the claude CLI against OpenRouter; needs OPENROUTER_API_KEY
//
// Optional env:
//   AGENTS="claude codex"          which agents to run (add "openrouter" to opt in)
//   BASE_BRANCH=main               branch to review (default: origin's default branch)
//   CLAUDE_MODEL / CODEX_MODEL   override each agent's model
//   OPENROUTER_MODEL=vendor/model  OpenRouter model slug (default z-ai/glm-5.3)
//   OPENROUTER_MAX_OUTPUT_TOKENS=16000   per-request output cap (Claude Code's default for an unknown model is 32000)
//   OPENROUTER_MAX_CONTEXT_TOKENS=<n>    the model's real context window (default: Claude Code assumes 200k)
//   OPENROUTER_AUTO_COMPACT_WINDOW=100000  compact the conversation at this many tokens (100000 to 1000000). Every turn
//                                        re-sends the conversation, so a smaller window means cheaper turns
//   OPENROUTER_MAX_TURNS=<n>             stop after this many agent turns (none by default). Hitting it ends the
//                                        run with an error and, if the report was not written yet, no PR
//   REPORT_DIR=security-reviews    where the findings file is committed in the PR
//   DRAFT=1                        open PRs as drafts (0 to disable)
//   PR_TITLE_PREFIX="fix(security)"  Conventional Commit type/scope for PR titles and commits
//   AGENT_TIMEOUT_MIN=60           kill an agent that runs longer than this
//   STREAM_LOGS=1                  print one progress line per tool call of the Claude Code based agents
//                                  (claude, openrouter) to the job log. Tool name and path only: never the
//                                  model's text or file contents. The full stream still goes to the agent log.
//   SARIF_DIR=<run dir>            where each agent's findings are written as <agent>.sarif
//                                  (never committed; the workflow uploads them to code scanning)

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { summarizeStreamLine } from "./stream-summary.mjs";

const env = process.env;
const AGENTS = (env.AGENTS ?? "claude codex").split(/\s+/).filter(Boolean);
const OPENROUTER_MODEL = env.OPENROUTER_MODEL || "z-ai/glm-5.3";
const REPORT_DIR = env.REPORT_DIR ?? "security-reviews";
const DRAFT = (env.DRAFT ?? "1") === "1";
const TITLE_PREFIX = env.PR_TITLE_PREFIX ?? "fix(security)"; // repos that squash-merge often require Conventional Commit titles
const TIMEOUT_MS = Number(env.AGENT_TIMEOUT_MIN ?? 60) * 60_000;
const STREAM_LOGS = (env.STREAM_LOGS ?? "0") === "1";
// The agents that run Claude Code, which can emit stream-json. Codex runs through its action, which already
// prints live to the job log.
const STREAMS = new Set(["claude", "openrouter"]);
const STREAM_FLAGS = ["--output-format", "stream-json", "--verbose"];
// The repo under review is untrusted. Claude Code would otherwise load its .claude/settings.json (hooks are
// shell commands it runs around every tool call, outside --allowedTools/--tools) and its .mcp.json servers.
// Load user settings only, and no MCP servers.
const UNTRUSTED_REPO_FLAGS = ["--setting-sources", "user", "--strict-mcp-config"];
// One id for every request of this run. OpenRouter's prompt cache only helps if each turn lands on the same
// provider, and its docs say a session id keeps routing consistent (x-session-id header).
const SESSION_ID = `bunyi-review-${env.GITHUB_RUN_ID ?? randomUUID()}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`;
const REPORT_FILE = ".security-review.md"; // agents write here, inside their worktree
const SARIF_FILE = ".security-review.sarif";

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const STAMP = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

const PROMPT = `You are helping the owner of this repository audit their own code defensively. The goal
is to find weaknesses and fix them before anyone can exploit them; nothing here is an attack, and
you should not write exploits. This is a security review of the repository in the current directory.

0. First enumerate the repository with your file-listing and search tools (for example glob for
   every source, config, workflow and script file), then review it directory by directory, reading
   the files themselves rather than inferring from names. A tool error is not a reason to stop: retry
   with different arguments (for example a valid line range) and keep going.
1. Review the whole codebase for security vulnerabilities: injection, authn/authz flaws,
   secrets in code, unsafe deserialization, path traversal, SSRF, insecure crypto,
   dependency risks, insecure defaults, and anything else you find.
2. Do NOT modify anything under .github/workflows/ (the token that publishes your changes is not
   allowed to push workflow files). Report workflow findings in the findings report and SARIF
   with Status "Not fixed (workflow file)" and describe the exact fix you would make.
   Fix every other finding you are confident about, with minimal, focused changes that keep
   existing behaviour and tests intact. Do not refactor unrelated code.
3. Write your findings to ./${REPORT_FILE} in Markdown with:
   - a one-paragraph summary
   - a "## Coverage" section listing the directories you reviewed and the notable files you read in
     each, and any part of the repo you did not or could not review, and why. A report that says
     nothing was found without this section is treated as a failed review.
   - a table: ID | Severity (Critical/High/Medium/Low) | File:line | Issue | Status (Fixed / Not fixed)
   - for each finding: description, impact, and either what you changed or why you left it
4. Also write every finding (fixed or not) to ./${SARIF_FILE} as SARIF 2.1.0 JSON:
   - one run; tool.driver.name "security-review"; tool.driver.rules with one rule per issue type:
     id, shortDescription.text, and properties { "tags": ["security", "<CWE id, e.g. CWE-89>"],
     "security-severity": "<9.0 critical, 7.0 high, 5.0 medium, 3.0 low>" }
   - one result per finding: ruleId, level ("error" for critical/high, "warning" for medium,
     "note" for low), message.text (the issue, plus "Fixed in this review's PR." if you fixed it),
     and one location: physicalLocation.artifactLocation.uri (path relative to the repo root,
     forward slashes) and region.startLine (and endLine if known)
   - if there are no findings, write a run with an empty results array
Do not run git commit, git push, or create branches or pull requests; that is handled for you.`;

// Each agent: binary, required key, and argv (no shell, so the prompt is never shell-parsed).
const AGENT_DEFS = {
  claude: {
    bin: "claude",
    key: "ANTHROPIC_API_KEY",
    args: () => [
      "-p", PROMPT,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,Write,Glob,Grep",
      // The model reads untrusted repo content, so limit it to these tools outright (allowedTools
      // only pre-approves; every other tool would stay available and just be denied on use).
      "--tools", "Read,Edit,Write,Glob,Grep",
      ...UNTRUSTED_REPO_FLAGS,
      ...(env.CLAUDE_MODEL ? ["--model", env.CLAUDE_MODEL] : []),
      ...(STREAM_LOGS ? STREAM_FLAGS : []),
    ],
  },
  codex: {
    bin: "codex",
    key: "OPENAI_API_KEY",
    extraEnv: () => ({ CODEX_API_KEY: env.OPENAI_API_KEY }),
    // --full-auto was removed in codex-cli 0.15x; exec is non-interactive, so the sandbox is the only knob.
    args: () => ["exec", "--sandbox", "workspace-write", ...(env.CODEX_MODEL ? ["--model", env.CODEX_MODEL] : []), PROMPT],
  },
  // Claude Code pointed at OpenRouter's Anthropic-compatible endpoint, with the same locked-down tools.
  openrouter: {
    bin: "claude",
    key: "OPENROUTER_API_KEY",
    extraEnv: () => ({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: env.OPENROUTER_API_KEY,
      ANTHROPIC_API_KEY: "", // must be empty so Claude Code uses the auth token
      ANTHROPIC_MODEL: OPENROUTER_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: OPENROUTER_MODEL,
      // OpenRouter reserves credit per request from the output cap times the model's price, plus
      // requests still in flight, and answers 402 when that exceeds the balance. Claude Code asks for
      // 32000 output tokens for a model it does not know, so ask for less: a review writes files in
      // a few thousand tokens at a time.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: env.OPENROUTER_MAX_OUTPUT_TOKENS || "16000",
      // Claude Code does not know these model ids and assumes a 200k window; say so when the real one is known.
      ...(env.OPENROUTER_MAX_CONTEXT_TOKENS ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: env.OPENROUTER_MAX_CONTEXT_TOKENS } : {}),
      // Cost: with little caching, every turn pays full input price for the whole conversation, so its size
      // is the bill. Compact earlier (the Claude Code minimum is 100000), and pin the provider per run so the
      // model's cache (Z.AI reads cost about a fifth of input) can hit.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.OPENROUTER_AUTO_COMPACT_WINDOW || "100000",
      ANTHROPIC_CUSTOM_HEADERS: `x-session-id: ${SESSION_ID}`,
    }),
    args: () => [
      "-p", PROMPT,
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,Write,Glob,Grep",
      "--model", OPENROUTER_MODEL,
      // Only these tools exist for the model. --allowedTools merely pre-approves; every other tool stays
      // available, and this model reached for Agent (sub-agents running in parallel, each holding a request
      // in flight, which is what OpenRouter's 402 "in-flight requests" refers to) and Bash (denied, so wasted turns).
      "--tools", "Read,Edit,Write,Glob,Grep",
      ...UNTRUSTED_REPO_FLAGS,
      ...(env.OPENROUTER_MAX_TURNS ? ["--max-turns", env.OPENROUTER_MAX_TURNS] : []),
      ...(STREAM_LOGS ? STREAM_FLAGS : []),
    ],
  },
};

// ---- helpers ---------------------------------------------------------------

const log = (agent, msg) => console.log(`[${agent}] ${msg}`);

// Credentials that must never reach an agent subprocess: the token that can push to the repo and
// open PRs, and every provider key except the one that agent needs. The agent reads a repository
// whose contents it did not write, so a prompt injection there must not be able to pick up another
// provider's key or a write token and copy it into the report, the SARIF or a fixed file.
const PROVIDER_KEYS = new Set(Object.values(AGENT_DEFS).map((d) => d.key));
const PUSH_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

function agentEnv(def) {
  const childEnv = { ...env };
  for (const k of PROVIDER_KEYS) if (k !== def.key) delete childEnv[k];
  for (const k of PUSH_TOKEN_VARS) delete childEnv[k];
  return { ...childEnv, ...(def.extraEnv?.() ?? {}) };
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

// git's network operations (fetch, push): when GH_TOKEN is in the environment, pass it as a
// per-command extraheader instead of relying on the credential actions/checkout persists in the
// repo's .git/config — that file is readable by an agent working in one of the repo's worktrees
// (Codex can run commands in its sandbox). Non-GitHub remotes and local runs without GH_TOKEN
// fall back to whatever credential helper the repo already uses.
const gitAuthArgs = () => env.GH_TOKEN
  ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64")}`]
  : [];

// Resolve a CLI name to { cmd, prefix } for spawn() without a shell, or null if not installed.
// On Windows, npm-global CLIs are .cmd shims that spawn() can't run without shell: true (which
// would shell-parse the prompt), so run the shim's target JS entry point with this node instead.
function resolveBin(bin) {
  // Look the name up from a neutral directory: where.exe searches the current directory before
  // PATH, so a `claude.exe` sitting in the repo under review would otherwise be the one that runs.
  const lookupOpts = { cwd: tmpdir() };
  if (process.platform !== "win32") {
    try { sh("which", [bin], lookupOpts); return { cmd: bin, prefix: [] }; } catch { return null; }
  }
  let hits;
  try { hits = sh("where", [bin], lookupOpts).split(/\r?\n/).filter(Boolean); } catch { return null; }
  const exe = hits.find((p) => extname(p).toLowerCase() === ".exe");
  if (exe) return { cmd: exe, prefix: [] };
  const cmd = hits.find((p) => extname(p).toLowerCase() === ".cmd");
  if (!cmd) return null;
  const m = readFileSync(cmd, "utf8").match(/"%dp0%\\([^"]+\.[cm]?js)"/);
  if (!m) throw new Error(`can't find the JS entry point in ${cmd}`);
  return { cmd: process.execPath, prefix: [join(dirname(cmd), m[1])] };
}

// Run an agent CLI, streaming stdout/stderr to a log file. Resolves with the exit code.
function runCli(cmd, args, { cwd, logPath, childEnv = env, onStdoutLine }) {
  return new Promise((resolveP) => {
    const out = createWriteStream(logPath);
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    if (onStdoutLine) {
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) { try { onStdoutLine(line); } catch { /* progress output must never fail a review */ } }
        }
      });
    }
    const timer = setTimeout(() => {
      out.write(`\n[security-review] timed out after ${TIMEOUT_MS / 60_000} min, killing\n`);
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      out.end(`\n[security-review] failed to start: ${err.message}\n`);
      resolveP(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end();
      resolveP(code ?? -1);
    });
  });
}

// ---- SARIF -----------------------------------------------------------------

// Move the agent's SARIF out of the worktree and tidy it into what code scanning accepts:
// repo-relative URIs, a startLine on every location, and results without a location dropped.
function exportSarif(agent, wt, ctx) {
  const src = join(wt, SARIF_FILE);
  // lstat, not stat/existsSync: an agent with a shell could leave a symlink here, and following it
  // would read a file from outside the worktree into an artifact that leaves the machine.
  const srcStat = lstatSync(src, { throwIfNoEntry: false });
  if (!srcStat) { log(agent, "no SARIF written"); return; }
  if (!srcStat.isFile()) {
    log(agent, `${SARIF_FILE} is not a regular file, skipping it`);
    rmSync(src, { force: true, recursive: true });
    return;
  }
  let sarif;
  try {
    sarif = JSON.parse(readFileSync(src, "utf8"));
  } catch (err) {
    log(agent, `SARIF is not valid JSON, skipping it (${err.message})`);
    return;
  } finally {
    rmSync(src);
  }

  const toRepoUri = (uri) => {
    let u = String(uri).replace(/^file:\/\/\/?/, "");
    try { u = decodeURIComponent(u); } catch { /* keep as is */ }
    if (isAbsolute(u)) u = relative(wt, u);
    return u.replace(/\\/g, "/").replace(/^\.\//, "");
  };
  let kept = 0, dropped = 0;
  sarif.version = "2.1.0";
  sarif.$schema ??= "https://json.schemastore.org/sarif-2.1.0.json";
  sarif.runs = (Array.isArray(sarif.runs) ? sarif.runs : []).map((run) => {
    run.tool ??= {};
    run.tool.driver ??= {};
    run.tool.driver.name ||= "security-review";
    run.tool.driver.fullName = `security-review (${agent})`;
    run.results = (run.results ?? []).filter((r) => {
      const locs = (r.locations ?? []).filter((l) => l?.physicalLocation?.artifactLocation?.uri);
      if (!r.message?.text || locs.length === 0) { dropped++; return false; }
      for (const l of locs) {
        const pl = l.physicalLocation;
        pl.artifactLocation.uri = toRepoUri(pl.artifactLocation.uri);
        delete pl.artifactLocation.uriBaseId;
        pl.region ??= {};
        pl.region.startLine = Math.max(1, Number(pl.region.startLine) || 1);
      }
      r.locations = locs;
      r.ruleId ||= "security-finding";
      kept++;
      return true;
    });
    return run;
  });

  const dir = env.SARIF_DIR || ctx.runDir;
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${agent}.sarif`);
  writeFileSync(dest, JSON.stringify(sarif, null, 2));
  log(agent, `SARIF: ${kept} finding(s)${dropped ? `, ${dropped} dropped (no message or location)` : ""} -> ${dest}`);
}

// ---- main flow -------------------------------------------------------------

async function runAgent(agent, ctx) {
  const def = AGENT_DEFS[agent];
  const branch = `security-review/${agent}-${STAMP}`;
  const prepared = ctx.prepared[agent];
  const wt = prepared ?? join(ctx.runDir, agent);
  const logPath = join(ctx.runDir, `${agent}.log`);

  if (prepared) {
    // The agent already ran elsewhere (e.g. a GitHub Action) inside this worktree, which
    // starts detached at origin/<base>; put it on the review branch and carry on from there.
    log(agent, `using output prepared in ${prepared}`);
    sh("git", ["checkout", "--quiet", "-b", branch], { cwd: wt });
  } else {
    log(agent, `reviewing (log: ${logPath})`);
    const code = await runCli(ctx.bins[agent].cmd, [...ctx.bins[agent].prefix, ...def.args()], {
      cwd: wt, logPath, childEnv: agentEnv(def),
      onStdoutLine: STREAM_LOGS && STREAMS.has(agent)
        // Claude Code's cost figure is an estimate at Claude's prices, so it is only shown for the claude agent.
        ? (line) => { const summary = summarizeStreamLine(line, { cost: agent === "claude" }); if (summary) log(agent, summary); }
        : undefined,
    });
    if (code !== 0) log(agent, `agent exited with code ${code}; see ${logPath}`);
  }

  exportSarif(agent, wt, ctx); // before git add -A, so the SARIF is never committed

  const report = join(wt, REPORT_FILE);
  // lstat, not stat: a symlink left here would be moved into the repo as the report, and its
  // target read into the PR body, disclosing a file from outside the worktree (a runner's
  // credentials, the checkout's .git/config) to everyone who can see the PR.
  const reportStat = lstatSync(report, { throwIfNoEntry: false });
  if (reportStat && !reportStat.isFile()) {
    throw new Error(`${REPORT_FILE} is not a regular file, so it is not a report; not opening a PR (see ${logPath})`);
  }
  if (!reportStat || reportStat.size === 0) {
    throw new Error(`no findings report written, so the review did not complete; not opening a PR (see ${logPath})`);
  }

  if (!/^#{1,6}\s*coverage/im.test(readFileSync(report, "utf8"))) {
    throw new Error(`report has no Coverage section, so it cannot show what was reviewed; not opening a PR (see ${logPath})`);
  }

  mkdirSync(join(wt, REPORT_DIR), { recursive: true });
  const committedReport = `${REPORT_DIR}/${STAMP}-${agent}.md`;
  renameSync(report, join(wt, committedReport));

  const git = (...a) => sh("git", a, { cwd: wt });
  // Workflow files can't be pushed with the workflow's GITHUB_TOKEN; drop any edits to them
  // (the agent is told not to make them, this keeps the push from failing if it does).
  const wfDir = ".github/workflows";
  if (git("status", "--porcelain", "--", wfDir)) {
    log(agent, `discarding changes under ${wfDir}/ (the token can't push workflow files)`);
    git("restore", "--source=HEAD", "--staged", "--worktree", "--", wfDir);
    git("clean", "-fdq", "--", wfDir);
  }
  git("add", "-A");
  const fixedFiles = git("diff", "--cached", "--name-only")
    .split("\n")
    .filter((f) => f && !f.startsWith(`${REPORT_DIR}/`)).length;
  git("commit", "--quiet", "-m", `${TITLE_PREFIX}: apply ${agent} security review findings`);
  git(...gitAuthArgs(), "push", "--quiet", "-u", "origin", branch);

  const reportText = readFileSync(join(wt, committedReport), "utf8");
  const bodyPath = join(ctx.runDir, `${agent}-body.md`);
  writeFileSync(
    bodyPath,
    `Automated security review by **${agent}** against \`${ctx.base}\`.\n` +
      `Files changed by fixes: **${fixedFiles}**. Full report: \`${committedReport}\`.\n\n` +
      reportText.slice(0, 60_000),
  );

  const prArgs = ["pr", "create", "--base", ctx.base, "--head", branch,
    "--title", `${TITLE_PREFIX}: apply ${agent} security review findings`, "--body-file", bodyPath];
  if (DRAFT) prArgs.push("--draft");
  const url = sh("gh", prArgs, { cwd: wt });
  log(agent, `PR opened: ${url}`);
}

async function main() {
  if (process.argv[2] === "--print-prompt") { // for agents run outside this script (the Codex action)
    process.stdout.write(`${PROMPT}\n`);
    return;
  }
  const repo = sh("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(process.argv[2] ?? ".") });
  const git = (...a) => sh("git", a, { cwd: repo });

  try {
    sh("gh", ["auth", "status"]);
  } catch {
    console.error("gh is not authenticated (run: gh auth login)");
    process.exit(1);
  }

  git(...gitAuthArgs(), "fetch", "--quiet", "origin");
  let base = env.BASE_BRANCH;
  if (!base) {
    try {
      base = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
    } catch {
      base = "main";
    }
  }

  const runDir = mkdtempSync(join(tmpdir(), `secreview-${STAMP}-`));
  // PREPARED_<AGENT>_WORKTREE=<path>: that agent already ran in <path> (a detached worktree of
  // origin/<base>), so skip its CLI, key check and worktree creation and just publish its output.
  const ctx = { repo, base, runDir, bins: {}, prepared: {} };

  // Remove the worktrees, and any branch nothing was committed to, however this run ends. A crash or
  // Ctrl-C would otherwise leave branches that make the next run in the same minute fail.
  const owned = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const { agent, wt } of owned) {
      const branch = `security-review/${agent}-${STAMP}`;
      try { git("worktree", "remove", "--force", wt); } catch { /* already gone */ }
      try {
        if (git("rev-list", "--count", `origin/${base}..${branch}`) === "0") git("branch", "-D", branch);
      } catch { /* branch was never created */ }
    }
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

  // Preflight, then create worktrees one at a time (parallel `git worktree add` races on git's lock).
  const ready = [];
  for (const agent of AGENTS) {
    // hasOwn, not a bare lookup: AGENTS="constructor" would otherwise resolve to Object.prototype's.
    if (!Object.hasOwn(AGENT_DEFS, agent)) { log(agent, "unknown agent, skipping"); continue; }
    const def = AGENT_DEFS[agent];
    const preparedDir = env[`PREPARED_${agent.toUpperCase()}_WORKTREE`];
    if (preparedDir) {
      ctx.prepared[agent] = resolve(preparedDir);
      owned.push({ agent, wt: ctx.prepared[agent] });
      ready.push(agent);
      continue;
    }
    let bin;
    try { bin = resolveBin(def.bin); } catch (err) { log(agent, `${err.message}, skipping`); continue; }
    if (!bin) { log(agent, `'${def.bin}' not installed, skipping`); continue; }
    if (!env[def.key]) { log(agent, `${def.key} not set, skipping`); continue; }
    git("worktree", "add", "--quiet", "-b", `security-review/${agent}-${STAMP}`, join(runDir, agent), `origin/${base}`);
    owned.push({ agent, wt: join(runDir, agent) });
    ctx.bins[agent] = bin;
    ready.push(agent);
  }
  if (ready.length === 0) {
    console.error("No agents could run.");
    process.exit(1);
  }

  // Run agents in parallel; one failing never stops the others.
  const results = await Promise.allSettled(ready.map((a) => runAgent(a, ctx)));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      log(ready[i], `failed: ${r.reason?.stderr || r.reason?.message || r.reason}`);
      process.exitCode = 1; // a failed agent must not leave a green run
    }
  });

  cleanup();
  console.log(`Done. Logs kept in ${runDir}`);
}

main().catch((err) => {
  console.error(err?.stderr || err?.message || err);
  process.exit(1);
});
