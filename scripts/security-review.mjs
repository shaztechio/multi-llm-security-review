#!/usr/bin/env node
// security-review.mjs — run Claude Code, Codex and Gemini CLI headlessly against a repo,
// each in its own git worktree, and open one draft PR per agent with fixes + findings.
//
// Usage:  node security-review.mjs [path/to/repo]          (default: current dir)
//
// Requires Node 18+, git, gh (authenticated), and whichever agent CLIs you want to run:
//   claude  (npm i -g @anthropic-ai/claude-code)   needs ANTHROPIC_API_KEY
//   codex   (npm i -g @openai/codex)               needs OPENAI_API_KEY
//   gemini  (npm i -g @google/gemini-cli)          needs GEMINI_API_KEY
//
// Optional env:
//   AGENTS="claude codex gemini"   which agents to run
//   BASE_BRANCH=main               branch to review (default: origin's default branch)
//   CLAUDE_MODEL / CODEX_MODEL / GEMINI_MODEL   override each agent's model
//   REPORT_DIR=security-reviews    where the findings file is committed in the PR
//   DRAFT=1                        open PRs as drafts (0 to disable)
//   AGENT_TIMEOUT_MIN=60           kill an agent that runs longer than this

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

const env = process.env;
const AGENTS = (env.AGENTS ?? "claude codex gemini").split(/\s+/).filter(Boolean);
const REPORT_DIR = env.REPORT_DIR ?? "security-reviews";
const DRAFT = (env.DRAFT ?? "1") === "1";
const TIMEOUT_MS = Number(env.AGENT_TIMEOUT_MIN ?? 60) * 60_000;
const REPORT_FILE = ".security-review.md"; // agents write here, inside their worktree

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const STAMP = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

const PROMPT = `You are performing a security review of this repository.

1. Review the whole codebase for security vulnerabilities: injection, authn/authz flaws,
   secrets in code, unsafe deserialization, path traversal, SSRF, insecure crypto,
   dependency risks, insecure defaults, and anything else you find.
2. Fix every finding you are confident about, with minimal, focused changes that keep
   existing behaviour and tests intact. Do not refactor unrelated code.
3. Write your findings to ./${REPORT_FILE} in Markdown with:
   - a one-paragraph summary
   - a table: ID | Severity (Critical/High/Medium/Low) | File:line | Issue | Status (Fixed / Not fixed)
   - for each finding: description, impact, and either what you changed or why you left it
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
      ...(env.CLAUDE_MODEL ? ["--model", env.CLAUDE_MODEL] : []),
    ],
  },
  codex: {
    bin: "codex",
    key: "OPENAI_API_KEY",
    extraEnv: () => ({ CODEX_API_KEY: env.OPENAI_API_KEY }),
    // --full-auto was removed in codex-cli 0.15x; exec is non-interactive, so the sandbox is the only knob.
    args: () => ["exec", "--sandbox", "workspace-write", ...(env.CODEX_MODEL ? ["--model", env.CODEX_MODEL] : []), PROMPT],
  },
  gemini: {
    bin: "gemini",
    key: "GEMINI_API_KEY",
    // --skip-trust: each worktree is a fresh temp dir, and untrusted folders downgrade the approval mode.
    args: () => ["-p", PROMPT, "--approval-mode", "auto_edit", "--skip-trust", ...(env.GEMINI_MODEL ? ["--model", env.GEMINI_MODEL] : [])],
  },
};

// ---- helpers ---------------------------------------------------------------

const log = (agent, msg) => console.log(`[${agent}] ${msg}`);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

// Resolve a CLI name to { cmd, prefix } for spawn() without a shell, or null if not installed.
// On Windows, npm-global CLIs are .cmd shims that spawn() can't run without shell: true (which
// would shell-parse the prompt), so run the shim's target JS entry point with this node instead.
function resolveBin(bin) {
  if (process.platform !== "win32") {
    try { sh("which", [bin]); return { cmd: bin, prefix: [] }; } catch { return null; }
  }
  let hits;
  try { hits = sh("where", [bin]).split(/\r?\n/).filter(Boolean); } catch { return null; }
  const exe = hits.find((p) => extname(p).toLowerCase() === ".exe");
  if (exe) return { cmd: exe, prefix: [] };
  const cmd = hits.find((p) => extname(p).toLowerCase() === ".cmd");
  if (!cmd) return null;
  const m = readFileSync(cmd, "utf8").match(/"%dp0%\\([^"]+\.[cm]?js)"/);
  if (!m) throw new Error(`can't find the JS entry point in ${cmd}`);
  return { cmd: process.execPath, prefix: [join(dirname(cmd), m[1])] };
}

// Run an agent CLI, streaming stdout/stderr to a log file. Resolves with the exit code.
function runCli(cmd, args, { cwd, logPath, extraEnv = {} }) {
  return new Promise((resolveP) => {
    const out = createWriteStream(logPath);
    const child = spawn(cmd, args, { cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
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

// ---- main flow -------------------------------------------------------------

async function runAgent(agent, ctx) {
  const def = AGENT_DEFS[agent];
  const branch = `security-review/${agent}-${STAMP}`;
  const wt = join(ctx.runDir, agent);
  const logPath = join(ctx.runDir, `${agent}.log`);

  log(agent, `reviewing (log: ${logPath})`);
  const code = await runCli(ctx.bins[agent].cmd, [...ctx.bins[agent].prefix, ...def.args()], { cwd: wt, logPath, extraEnv: def.extraEnv?.() });
  if (code !== 0) log(agent, `agent exited with code ${code}; see ${logPath}`);

  const report = join(wt, REPORT_FILE);
  if (!existsSync(report) || statSync(report).size === 0) {
    log(agent, `no findings report written; skipping PR (see ${logPath})`);
    return;
  }

  mkdirSync(join(wt, REPORT_DIR), { recursive: true });
  const committedReport = `${REPORT_DIR}/${STAMP}-${agent}.md`;
  renameSync(report, join(wt, committedReport));

  const git = (...a) => sh("git", a, { cwd: wt });
  git("add", "-A");
  const fixedFiles = git("diff", "--cached", "--name-only")
    .split("\n")
    .filter((f) => f && !f.startsWith(`${REPORT_DIR}/`)).length;
  git("commit", "--quiet", "-m", `Security review (${agent}): findings and fixes`);
  git("push", "--quiet", "-u", "origin", branch);

  const reportText = readFileSync(join(wt, committedReport), "utf8");
  const bodyPath = join(ctx.runDir, `${agent}-body.md`);
  writeFileSync(
    bodyPath,
    `Automated security review by **${agent}** against \`${ctx.base}\`.\n` +
      `Files changed by fixes: **${fixedFiles}**. Full report: \`${committedReport}\`.\n\n` +
      reportText.slice(0, 60_000),
  );

  const prArgs = ["pr", "create", "--base", ctx.base, "--head", branch,
    "--title", `Security review (${agent}) — ${STAMP}`, "--body-file", bodyPath];
  if (DRAFT) prArgs.push("--draft");
  const url = sh("gh", prArgs, { cwd: wt });
  log(agent, `PR opened: ${url}`);
}

async function main() {
  const repo = sh("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(process.argv[2] ?? ".") });
  const git = (...a) => sh("git", a, { cwd: repo });

  try {
    sh("gh", ["auth", "status"]);
  } catch {
    console.error("gh is not authenticated (run: gh auth login)");
    process.exit(1);
  }

  git("fetch", "--quiet", "origin");
  let base = env.BASE_BRANCH;
  if (!base) {
    try {
      base = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
    } catch {
      base = "main";
    }
  }

  const runDir = mkdtempSync(join(tmpdir(), `secreview-${STAMP}-`));
  const ctx = { repo, base, runDir, bins: {} };

  // Preflight, then create worktrees one at a time (parallel `git worktree add` races on git's lock).
  const ready = [];
  for (const agent of AGENTS) {
    const def = AGENT_DEFS[agent];
    if (!def) { log(agent, "unknown agent, skipping"); continue; }
    let bin;
    try { bin = resolveBin(def.bin); } catch (err) { log(agent, `${err.message}, skipping`); continue; }
    if (!bin) { log(agent, `'${def.bin}' not installed, skipping`); continue; }
    if (!env[def.key]) { log(agent, `${def.key} not set, skipping`); continue; }
    git("worktree", "add", "--quiet", "-b", `security-review/${agent}-${STAMP}`, join(runDir, agent), `origin/${base}`);
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
    if (r.status === "rejected") log(ready[i], `failed: ${r.reason?.stderr || r.reason?.message || r.reason}`);
  });

  for (const agent of ready) {
    try { git("worktree", "remove", "--force", join(runDir, agent)); } catch { /* already gone */ }
  }
  console.log(`Done. Logs kept in ${runDir}`);
}

main().catch((err) => {
  console.error(err?.stderr || err?.message || err);
  process.exit(1);
});
