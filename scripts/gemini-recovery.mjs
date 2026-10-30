// Copyright 2026 Shazron Abdullah
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function geminiOutputComplete(worktree) {
  for (const file of [".security-review.md", ".security-review.sarif"]) {
    const path = join(worktree, file);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.size === 0) return false;
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  }
  if (!/^#{1,6}\s*coverage/im.test(readFileSync(join(worktree, ".security-review.md"), "utf8"))) return false;
  try {
    const sarif = JSON.parse(readFileSync(join(worktree, ".security-review.sarif"), "utf8"));
    return sarif.version === "2.1.0" && Array.isArray(sarif.runs) && sarif.runs.length > 0
      && sarif.runs.every((run) => Array.isArray(run.results));
  } catch { return false; }
}

// One continuation, never a fresh review or an invented report. Both attempts
// share the original deadline; a second incomplete result remains a failure.
export async function runGeminiReview({ run, complete, timeoutMs, onRetry, now = Date.now }) {
  const deadline = now() + timeoutMs;
  const code = await run({ resume: false, timeoutMs });
  if (code !== 0 || complete()) return code;
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Gemini review timed out before completing its output");
  onRetry();
  const retryCode = await run({ resume: true, timeoutMs: remaining });
  if (retryCode !== 0) return retryCode;
  if (!complete()) throw new Error("Gemini ended without a complete findings report and SARIF after one continuation");
  return retryCode;
}

export const GEMINI_COMPLETION_PROMPT = `Continue the security review in this same worktree using the existing session and reviewed files.
Your previous turn ended without the required output files. Finish the review and use write_file
now to save ./.security-review.md with a summary, a ## Coverage section describing the actual
coverage and any limitations, and the findings table; also save ./.security-review.sarif as valid
SARIF 2.1.0 with one run and a results array (empty only if there are no findings).
Do not claim unreviewed files were reviewed. Preserve existing fixes. Do not modify workflows,
commit, push, or open a PR. A final chat answer is not a substitute for writing both files.`;
