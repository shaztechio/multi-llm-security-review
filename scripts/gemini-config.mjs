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

import { join } from "node:path";
import { writeFileSync } from "node:fs";

// System overrides take precedence over the untrusted repository's settings.
// Keep executable integrations disabled even if the repo configures them.
export function geminiEnvironment(runDir) {
  const settingsPath = join(runDir, "gemini-settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    general: { enableAutoUpdate: false },
    tools: { sandbox: false, core: ["read_file", "read_many_files", "list_directory", "glob", "grep_search", "replace", "write_file"],
      discoveryCommand: "", callCommand: "" },
    hooksConfig: { enabled: false },
    admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
    skills: { enabled: false },
    experimental: { enableAgents: false },
    advanced: { ignoreLocalEnv: true },
    security: { auth: { selectedType: "gemini-api-key", enforcedType: "gemini-api-key" } },
  }));
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath, GOOGLE_API_KEY: "",
    GOOGLE_GENAI_USE_VERTEXAI: "false", GOOGLE_GENAI_USE_GCA: "false" };
}
