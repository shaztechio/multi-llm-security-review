// Copyright 2026 Shazron Abdullah
// SPDX-License-Identifier: Apache-2.0

// Run on Linux after installing the pinned Gemini CLI and the system settings.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS_PATH, GEMINI_SETTINGS, validateGeminiSettings } from "./gemini-config.mjs";

const bundle = process.argv[2];
let check;
for (const name of readdirSync(bundle).filter((name) => name.endsWith(".js"))) {
  const file = join(bundle, name);
  if (!readFileSync(file, "utf8").includes("  isFileAndDirectorySecureSync,")) continue;
  const module = await import(pathToFileURL(file).href);
  if (typeof module.isFileAndDirectorySecureSync === "function") {
    check = module.isFileAndDirectorySecureSync;
    break;
  }
}
assert.equal(typeof check, "function", "Pinned Gemini path-security validator must be available");
assert.equal(validateGeminiSettings(DEFAULT_SETTINGS_PATH), DEFAULT_SETTINGS_PATH);
assert.deepEqual(check(DEFAULT_SETTINGS_PATH), { secure: true });
const temp = mkdtempSync(join(tmpdir(), "gemini-insecure-settings-"));
try {
  const file = join(temp, "settings.json");
  writeFileSync(file, JSON.stringify(GEMINI_SETTINGS));
  assert.equal(check(file).secure, false, "Gemini must reject the old temp-file approach");
  assert.throws(() => validateGeminiSettings(file));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log("Gemini accepts installed system settings and rejects temporary settings.");
