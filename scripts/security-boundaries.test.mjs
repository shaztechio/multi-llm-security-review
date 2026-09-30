import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentEnvironment, reportDirectory, reviewFile } from "./security-boundaries.mjs";

test("agents receive only their selected provider credentials without mutating the publisher", () => {
  const parent = { PATH: "runtime", GH_TOKEN: "publisher", github_token: "publisher",
    ANTHROPIC_API_KEY: "claude", OPENAI_API_KEY: "openai", OPENROUTER_API_KEY: "router",
    ANTHROPIC_AUTH_TOKEN: "stale", CODEX_API_KEY: "stale", ACTIONS_RUNTIME_TOKEN: "artifact" };
  assert.deepEqual(agentEnvironment(parent, "ANTHROPIC_API_KEY"), { PATH: "runtime", ANTHROPIC_API_KEY: "claude" });
  assert.deepEqual(agentEnvironment(parent, "OPENAI_API_KEY", { CODEX_API_KEY: parent.OPENAI_API_KEY }),
    { PATH: "runtime", OPENAI_API_KEY: "openai", CODEX_API_KEY: "openai" });
  assert.deepEqual(agentEnvironment(parent, "OPENROUTER_API_KEY", { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "router" }),
    { PATH: "runtime", OPENROUTER_API_KEY: "router", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "router" });
  assert.equal(parent.GH_TOKEN, "publisher");
  assert.equal(parent.ANTHROPIC_AUTH_TOKEN, "stale");
});

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "security-boundaries-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  return { root, worktree };
}

test("report destinations stay inside the worktree and accept nested directories", (context) => {
  const { root, worktree } = fixture(context);
  assert.equal(reportDirectory(worktree, "reports/nested"), join(worktree, "reports", "nested"));
  for (const directory of ["..", "../outside", root, ".", ""]) {
    assert.throws(() => reportDirectory(worktree, directory), /inside the worktree/);
  }
  writeFileSync(join(worktree, "file"), "report");
  assert.throws(() => reportDirectory(worktree, "file/nested"), /symbolic links or files/);
});

test("directory links are rejected even when their target is inside the fixture", (context) => {
  const { root, worktree } = fixture(context);
  const target = join(root, "target");
  mkdirSync(target);
  symlinkSync(target, join(worktree, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => reportDirectory(worktree, "linked/nested"), /symbolic links or files/);
});

test("review artifacts must be regular files", (context) => {
  const { worktree } = fixture(context);
  writeFileSync(join(worktree, ".security-review.md"), "## Coverage");
  assert.equal(reviewFile(worktree, ".security-review.md"), join(worktree, ".security-review.md"));
  mkdirSync(join(worktree, ".security-review.sarif"));
  assert.throws(() => reviewFile(worktree, ".security-review.sarif"), /regular file/);
});

test("review artifacts cannot be file links", (context) => {
  const { worktree } = fixture(context);
  const target = join(worktree, "target.md");
  writeFileSync(target, "## Coverage");
  try {
    symlinkSync(target, join(worktree, ".security-review.md"), "file");
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    context.skip("File symlink creation requires privileges on this Windows host");
    return;
  }
  assert.throws(() => reviewFile(worktree, ".security-review.md"), /regular file/);
});
