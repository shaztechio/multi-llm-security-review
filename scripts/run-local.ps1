# Copyright 2026 Shazron Abdullah
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Local runner for security-review.mjs (Windows PowerShell). Usage: scripts\run-local.ps1 [repo-path]
# Keys come from your session or a git-ignored .env file (see .env.example) at the repo root,
# or the file named by $env:SECREVIEW_ENV_FILE. Variables already set in your session win over the file.
# AGENTS defaults to "claude openrouter"; override with e.g. $env:AGENTS = "claude codex".

<#
.SYNOPSIS
Runs security-review.mjs locally on a repo.

.DESCRIPTION
Each agent reviews the code, fixes what it is confident about, pushes a branch and opens a
draft PR. Keys are read from the session, or from a git-ignored .env file at the repo root
(see .env.example). Variables already set in your session win over the file. PATH, HOME, NODE_*,
GIT_*, LD_*, DYLD_* and similar are ignored in the file.

Environment:
  ANTHROPIC_API_KEY     needed for agent "claude"
  OPENROUTER_API_KEY    needed for agent "openrouter"
  OPENAI_API_KEY        needed for agent "codex"
  AGENTS                space-separated agents (default: "claude openrouter")
  OPENROUTER_MAX_TURNS  turn cap for openrouter (default: 60)
  SECREVIEW_ENV_FILE    use this env file instead of <repo>/.env

Any other variable documented in the README (BASE_BRANCH, DRAFT, ...) is passed through.

.PARAMETER Target
Repo to review. Default: this repo.

.PARAMETER Help
Show this help.

.EXAMPLE
.\scripts\run-local.ps1

.EXAMPLE
$env:AGENTS = "claude codex"; .\scripts\run-local.ps1 ..\other-repo
#>
param(
  [string]$Target = (Join-Path $PSScriptRoot '..'),
  [Alias('h')][switch]$Help
)

if ($Help) { Get-Help $PSCommandPath -Detailed; exit 0 }

$ErrorActionPreference = 'Stop'

$envFile = if ($env:SECREVIEW_ENV_FILE) { $env:SECREVIEW_ENV_FILE } else { Join-Path $PSScriptRoot '..\.env' }
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $name = $Matches[1]; $val = $Matches[2].Trim().Trim('"').Trim("'")
      # A .env can arrive from elsewhere (a teammate, a cloned repo); these would turn it into code
      # execution in the node/git/gh children, so they can only come from your own session.
      if ($name -match '^(PATH|PATHEXT|COMSPEC|HOME|USERPROFILE|PSModulePath|NODE_.*|GIT_.*|LD_.*|DYLD_.*)$') {
        Write-Warning "ignoring $name in $envFile (set it in your session if you mean it)"
        continue
      }
      if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue).Value) { Set-Item "env:$name" $val }
    }
  }
}

foreach ($cmd in 'node', 'git', 'gh') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "missing: $cmd" }
}
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'gh is not authenticated (run: gh auth login)' }
if ([int](node -p 'process.versions.node.split(".")[0]') -lt 18) { throw 'Node 18+ required' }

if (-not $env:AGENTS) { $env:AGENTS = 'claude openrouter' }
if (-not $env:OPENROUTER_MAX_TURNS) { $env:OPENROUTER_MAX_TURNS = '60' }

$keys = @{ claude = 'ANTHROPIC_API_KEY'; openrouter = 'OPENROUTER_API_KEY'; codex = 'OPENAI_API_KEY' }
foreach ($a in $env:AGENTS -split '\s+' | Where-Object { $_ }) {
  $k = $keys[$a]
  if ($k -and -not (Get-Item "env:$k" -ErrorAction SilentlyContinue).Value) { throw "$k not set" }
}

node (Join-Path $PSScriptRoot 'security-review.mjs') $Target
exit $LASTEXITCODE
