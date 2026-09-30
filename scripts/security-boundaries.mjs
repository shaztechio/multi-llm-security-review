import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const CREDENTIALS = new Set([
  "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
  "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ACTIONS_RUNTIME_TOKEN",
]);

export function agentEnvironment(parent, key, extra = {}) {
  const child = Object.fromEntries(Object.entries(parent).filter(([name]) => !CREDENTIALS.has(name.toUpperCase())));
  if (parent[key]) child[key] = parent[key];
  return { ...child, ...extra };
}

export function reviewFile(worktree, name) {
  const file = join(worktree, name);
  if (!lstatSync(file).isFile()) throw new Error(`${name} must be a regular file, not a symbolic link`);
  return file;
}

export function reportDirectory(worktree, directory) {
  const root = realpathSync(worktree);
  const destination = resolve(root, directory);
  const path = relative(root, destination);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("REPORT_DIR must be a directory inside the worktree");
  }
  let current = root;
  for (const component of path.split(sep)) {
    current = join(current, component);
    try {
      if (!lstatSync(current).isDirectory()) throw new Error("REPORT_DIR must not contain symbolic links or files");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current);
    }
  }
  return destination;
}
