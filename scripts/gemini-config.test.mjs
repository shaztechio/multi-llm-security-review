// Copyright 2026 Shazron Abdullah
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GEMINI_SETTINGS, validateGeminiSettings } from "./gemini-config.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-config-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "settings.json");
}

test("missing system settings fail closed", (t) => {
  assert.throws(() => validateGeminiSettings(fixture(t)), { code: "ENOENT" });
});

test("settings with protections removed or extra tools fail closed", (t) => {
  const path = fixture(t);
  for (const mutate of [
    (s) => { s.hooksConfig.enabled = true; },
    (s) => { s.tools.core.push("run_shell_command"); },
    (s) => { s.admin.mcp.enabled = true; },
  ]) {
    const settings = structuredClone(GEMINI_SETTINGS);
    mutate(settings);
    writeFileSync(path, JSON.stringify(settings));
    assert.throws(() => validateGeminiSettings(path), /do not match/);
  }
});

test("a normal user temp settings file is not accepted as system policy", (t) => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify(GEMINI_SETTINGS));
  // Temp files have a user-owned or writable ancestor, even when tests run as root.
  assert.throws(() => validateGeminiSettings(path));
});
