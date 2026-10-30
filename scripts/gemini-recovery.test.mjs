// Copyright 2026 Shazron Abdullah
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGeminiReview, geminiOutputComplete } from "./gemini-recovery.mjs";

test("premature successful exit resumes once within the original budget", async () => {
  const calls = [];
  let time = 100, complete = false, retries = 0;
  assert.equal(await runGeminiReview({ timeoutMs: 1000, now: () => time,
    complete: () => complete, onRetry: () => retries++,
    run: async (options) => { calls.push(options); time += 400; complete = options.resume; return 0; },
  }), 0);
  assert.deepEqual(calls, [{ resume: false, timeoutMs: 1000 }, { resume: true, timeoutMs: 600 }]);
  assert.equal(retries, 1);
});

test("complete output and CLI failures do not trigger another API attempt", async () => {
  for (const code of [0, 1]) {
    let attempts = 0;
    assert.equal(await runGeminiReview({ timeoutMs: 1000, complete: () => true,
      onRetry: () => assert.fail("unexpected retry"), run: async () => { attempts++; return code; },
    }), code);
    assert.equal(attempts, 1);
  }
});

test("second incomplete output fails and an expired deadline never retries", async () => {
  let attempts = 0;
  await assert.rejects(runGeminiReview({ timeoutMs: 1000, complete: () => false, onRetry: () => {},
    run: async () => { attempts++; return 0; },
  }), /after one continuation/);
  assert.equal(attempts, 2);
  let clock = 0;
  await assert.rejects(runGeminiReview({ timeoutMs: 10, now: () => clock, complete: () => false,
    onRetry: () => assert.fail("unexpected retry"), run: async () => { clock = 20; return 0; },
  }), /timed out/);
});

test("completion requires a real coverage report and valid SARIF, including no findings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-output-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(geminiOutputComplete(dir), false);
  writeFileSync(join(dir, ".security-review.md"), "## Coverage\nReviewed src, no findings.");
  writeFileSync(join(dir, ".security-review.sarif"), "invalid");
  assert.equal(geminiOutputComplete(dir), false);
  writeFileSync(join(dir, ".security-review.sarif"), JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }));
  assert.equal(geminiOutputComplete(dir), true);
  writeFileSync(join(dir, ".security-review.md"), "No coverage");
  assert.equal(geminiOutputComplete(dir), false);
});
