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

import { dirname, join, parse, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { lstatSync, readFileSync } from "node:fs";

// Install these system overrides outside the repository before trusting the worktree.
export const GEMINI_SETTINGS = {
    general: { enableAutoUpdate: false },
    tools: { sandbox: false, core: ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "replace", "write_file"],
      discoveryCommand: "", callCommand: "" },
    hooksConfig: { enabled: false },
    admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
    skills: { enabled: false },
    experimental: { enableAgents: false },
    advanced: { ignoreLocalEnv: true },
    security: { auth: { selectedType: "gemini-api-key", enforcedType: "gemini-api-key" } },
};

export const DEFAULT_SETTINGS_PATH = process.platform === "win32"
  ? join(process.env.ProgramData || "C:\\ProgramData", "gemini-cli", "security-review.json")
  : "/etc/gemini-cli/security-review.json";

// Gemini validates every ancestor as well as the settings file. Reject symlinks and
// writable paths here too, so --skip-trust can never silently disable our protections.
export function validateGeminiSettings(settingsPath) {
  const file = resolve(settingsPath);
  if (!isDeepStrictEqual(JSON.parse(readFileSync(file, "utf8")), GEMINI_SETTINGS)) {
    throw new Error("Gemini system settings do not match the required security-review configuration; reinstall them");
  }
  const paths = [];
  for (let current = file;; current = dirname(current)) {
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || (current === file ? !stats.isFile() : !stats.isDirectory())) {
      throw new Error(`Gemini settings path must not contain symlinks: ${current}`);
    }
    if (process.platform !== "win32" && (stats.uid !== 0 || (stats.mode & 0o022))) {
      throw new Error(`Gemini settings path must be root-owned and not group/world writable: ${current}`);
    }
    if (process.platform !== "win32" || current !== parse(current).root) paths.push(current);
    if (current === parse(current).root) break;
  }
  if (process.platform === "win32") {
    // Use SIDs rather than localized account names. Gemini also requires an admin-owned
    // path on Windows; normal user temp directories are not accepted.
    const script = `
$ErrorActionPreference = 'Stop'
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(paths)).toString("base64")}')))
foreach ($p in $paths) {
  $acl = Get-Acl -LiteralPath $p
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw "Gemini settings path is not administrator-owned: $p" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if (-not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0xD0156) -and $rule.IdentityReference.Value -notin $trusted) { throw "Gemini settings path is writable by a non-administrator: $p" }
  }
}`;
    execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "pipe" });
  }
  return file;
}

export function geminiEnvironment() {
  const settingsPath = process.env.SECREVIEW_GEMINI_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
  try {
    validateGeminiSettings(settingsPath);
  } catch (error) {
    throw new Error(`Gemini security settings are not installed securely at ${settingsPath}: ${error.message}. See README Gemini setup.`, { cause: error });
  }
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: resolve(settingsPath), GOOGLE_API_KEY: "",
    GOOGLE_GENAI_USE_VERTEXAI: "false", GOOGLE_GENAI_USE_GCA: "false" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`${JSON.stringify(GEMINI_SETTINGS, null, 2)}\n`);
}
