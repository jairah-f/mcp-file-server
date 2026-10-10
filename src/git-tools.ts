// M4, part B: "git-lite". Three READ-ONLY tools: git_status, git_diff, git_log.
//
// Safety rules (this is NOT a way to run commands):
//   - There is no generic "run a command" tool. Each tool builds a FIXED git command.
//   - git is started with execFile and an argument list. No shell is involved, so
//     characters like ; | & $( ) in a tool argument are never interpreted.
//   - The only free-text input is a path. It goes through the workspace sandbox
//     (resolveSafePath) and is passed to git after "--", as a literal path.
//   - status and diff are limited to the workspace/ folder. Commands that write
//     (add, commit, push, checkout, ...) do not exist here.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SandboxError, WORKSPACE_ROOT, fail, ok, resolveSafePath } from "./tools.js";

// The project repository: the folder that contains workspace/.
const PROJECT_ROOT = path.resolve(WORKSPACE_ROOT, "..");

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_OUTPUT_LINES = 300;
const MAX_OUTPUT_CHARS = 30_000;

// An error whose message is safe to show to the client.
class GitToolError extends SandboxError {}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

// Words in the first line of git's error that we recognise and explain.
function explainGitFailure(error: { code?: string | number; killed?: boolean }, stderr: string): GitToolError {
  const text = stderr.toLowerCase();
  if (error.code === "ENOENT") {
    return new GitToolError("Git is not installed (or not on the PATH) on the computer running the server.");
  }
  if (error.killed) {
    return new GitToolError(`Git took longer than ${GIT_TIMEOUT_MS / 1000} seconds and was stopped.`);
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new GitToolError("Git produced too much output. Use the 'path' option to look at fewer files.");
  }
  if (text.includes("not a git repository")) {
    return new GitToolError("This project folder is not a Git repository. Run 'git init' in the project folder first.");
  }
  if (text.includes("does not have any commits yet") || text.includes("bad default revision")) {
    return new GitToolError("This repository has no commits yet.");
  }
  if (text.includes("dubious ownership")) {
    return new GitToolError("Git refuses to use this folder because of its ownership (safe.directory). See the README troubleshooting note.");
  }
  // Unknown problem: show git's first line, without the project's absolute path.
  const firstLine = stderr.split("\n").find((l) => l.trim() !== "") ?? "unknown error";
  return new GitToolError(`Git command failed: ${firstLine.split(PROJECT_ROOT).join("<project>").trim().slice(0, 200)}`);
}

// Run one fixed git command and return its output.
async function runGit(args: string[]): Promise<string> {
  // The repository must be in the project folder itself, not in a parent folder.
  const hasGitFolder = await fs.stat(path.join(PROJECT_ROOT, ".git")).then(
    () => true,
    () => false
  );
  if (!hasGitFolder) {
    throw new GitToolError("This project folder is not a Git repository. Run 'git init' in the project folder first.");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never wait for a password
    LC_ALL: "C", // predictable English messages
    GIT_CEILING_DIRECTORIES: path.dirname(PROJECT_ROOT), // never look in parent folders for a repository
  };
  // If the person who started the server had these set, they would point git somewhere else.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF"]) delete env[name];

  const safeOptions = [
    "--no-optional-locks", // read-only: do not even refresh the index file
    "--literal-pathspecs", // a path is a path: no wildcards or special ":(...)" syntax
    "-c", "core.quotepath=false",
    "-c", "color.ui=false",
    "-c", "core.pager=cat",
    "-c", "core.fsmonitor=false",
  ];

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...safeOptions, ...args],
      { cwd: PROJECT_ROOT, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => (error ? reject(explainGitFailure(error, String(stderr))) : resolve(stdout))
    );
  });
}

// A path the agent gave (relative to workspace/) -> the same path as git sees it ("workspace/...").
// The sandbox check happens here, before git is started.
async function pathForGit(userPath: string | undefined): Promise<string> {
  const target = await resolveSafePath(userPath ?? ".", { allowRoot: true });
  return path.relative(PROJECT_ROOT, target).split(path.sep).join("/");
}

// Keep tool output small.
function shorten(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  let out = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  let cut = lines.length > MAX_OUTPUT_LINES;
  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS);
    cut = true;
  }
  return cut ? `${out}\n\n[Output shortened. Use the 'path' option to look at fewer files.]` : out;
}

// ---------------------------------------------------------------------------
// The three tools
// ---------------------------------------------------------------------------

const pathField = z
  .string()
  .max(1000)
  .optional()
  .describe("Optional file or folder, relative to the workspace root (default: the whole workspace).");

export function registerGitTools(server: McpServer): void {
  const readOnly = { readOnlyHint: true } as const;

  // 1. git_status
  server.registerTool(
    "git_status",
    {
      description:
        "Show the Git status of the workspace folder: the current branch and which files are new (??), modified (M), added (A) or deleted (D). " +
        "Read-only. Only files inside workspace/ are shown.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async () => {
      try {
        const spec = await pathForGit(".");
        const output = await runGit(["status", "--short", "--branch", "--untracked-files=all", "--", spec]);
        const lines = output.split("\n").filter((l) => l !== "");
        const changes = lines.filter((l) => !l.startsWith("## "));
        const note = changes.length === 0 ? "\n\nNo changes in workspace/ (clean)." : "";
        return ok(shorten(output) + note);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 2. git_diff
  server.registerTool(
    "git_diff",
    {
      description:
        "Show what changed in tracked files of the workspace folder (like 'git diff'). Read-only. " +
        "By default shows changes not yet staged; set staged=true for staged changes. New untracked files are listed by git_status, not here.",
      inputSchema: z.strictObject({
        path: pathField,
        staged: z.boolean().default(false).describe("true = show staged changes instead of unstaged ones."),
        stat_only: z.boolean().default(false).describe("true = only a summary of changed files and line counts."),
      }),
      annotations: readOnly,
    },
    async ({ path: userPath, staged, stat_only }) => {
      try {
        const spec = await pathForGit(userPath);
        const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
        if (staged) args.push("--cached");
        if (stat_only) args.push("--stat");
        args.push("--", spec);
        const output = await runGit(args);
        if (output.trim() === "") {
          return ok(`No ${staged ? "staged" : "unstaged"} changes in ${spec}. (Untracked files do not appear in a diff; use git_status.)`);
        }
        return ok(shorten(output));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 3. git_log
  server.registerTool(
    "git_log",
    {
      description:
        "Show recent commits of the project: short hash, date and message (no author names or e-mail addresses). Read-only.",
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(50).default(10).describe("How many commits to show (1-50)."),
        path: pathField.describe("Optional: only commits that changed this file or folder (relative to the workspace root)."),
      }),
      annotations: readOnly,
    },
    async ({ limit, path: userPath }) => {
      try {
        const args = ["log", `--max-count=${limit}`, "--date=short", "--no-color", "--pretty=format:%h %ad %s", "--"];
        if (userPath !== undefined) args.push(await pathForGit(userPath));
        const output = await runGit(args);
        return ok(output.trim() === "" ? "No commits found." : shorten(output));
      } catch (err) {
        return fail(err);
      }
    }
  );
}