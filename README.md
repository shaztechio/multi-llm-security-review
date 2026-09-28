# multi-llm-security-review

Runs Claude Code, Codex and Gemini CLI against a repo in parallel. Each agent reviews the
code for security issues, fixes what it is confident about, and opens its own PR with the
fixes and a findings report.

- `scripts/security-review.mjs`: the tool. Run it locally: `node scripts/security-review.mjs path/to/repo`
- `.github/workflows/security-review.yml`: reusable workflow (`workflow_call`)
- `examples/caller.yml`: copy into any repo to get a "Run workflow" button with provider checkboxes

Keep this repo public (it contains no secrets), or callers must be granted access to it
under Settings → Actions → General → Access.

## API keys

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and/or `GEMINI_API_KEY` as secrets **in each calling repo**
(only for the providers you tick). Never add them to this repo: `.github/workflows/no-secrets.yml` fails if
this repo can see any of them (including org secrets shared with it), and the reusable workflow refuses to run
from this repo. A run also fails if a ticked provider has no key.
