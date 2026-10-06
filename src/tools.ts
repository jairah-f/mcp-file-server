// Shared code for both entry points: the workspace sandbox (resolveSafePath)
// and the five file tools. Nothing in here depends on HOW the server is
// reached (stdio or HTTP).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Workspace + limits
// ---------------------------------------------------------------------------

// Folder containing this file. (import.meta.dirname needs Node 20.11+, so we
// derive it from import.meta.url, which works on older Node versions too.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The workspace root: the ONLY folder this server is allowed to touch.
// It is the "workspace" folder next to "src" (i.e. mcp-file-server/workspace).
export const WORKSPACE_ROOT = path.resolve(__dirname, "..", "workspace");

// Largest file we will read or write, so a huge file cannot flood memory.
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Sandbox: the ONE place where user-provided paths are checked
// ---------------------------------------------------------------------------

// An error whose message is safe to show to the MCP client.
class SandboxError extends Error {}

const OUTSIDE_MESSAGE = "Path is outside the workspace.";

// True if `target` is `root` itself or somewhere inside it.
// path.relative() also copes with Windows drive letters and case-insensitivity:
// if the result starts with ".." (or is absolute, e.g. a different drive),
// the target is outside the root.
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

// Turn a user-provided path into a safe absolute path inside the workspace,
// or throw a SandboxError. EVERY file tool must call this before touching disk.
//
// Steps:
//   1. Reject obviously invalid input (null bytes, absolute paths, Windows drive tricks).
//   2. Resolve the path against the workspace root (this collapses "..", ".", "/" or "\").
//   3. Check the resolved path is still inside the workspace.
//   4. Follow symlinks/junctions: the real location of the deepest existing
//      part of the path must ALSO be inside the real workspace folder.
async function resolveSafePath(
  userPath: string,
  options: { allowRoot?: boolean } = {}
): Promise<string> {
  // 1. Basic validation.
  if (userPath.includes("\0")) {
    throw new SandboxError("Invalid path.");
  }
  // Paths must be relative to the workspace. We check both Windows and POSIX
  // styles so "C:\\x" and "/x" are refused no matter which OS runs the server.
  if (path.isAbsolute(userPath) || path.win32.isAbsolute(userPath)) {
    throw new SandboxError("Absolute paths are not allowed. Use a path relative to the workspace.");
  }
  // On Windows a colon can mean a drive ("C:foo") or an alternate data stream.
  if (process.platform === "win32" && userPath.includes(":")) {
    throw new SandboxError("Invalid path.");
  }

  // 2 + 3. Resolve, then verify with real path logic (not a "contains .." string check).
  const target = path.resolve(WORKSPACE_ROOT, userPath);
  if (!isInside(WORKSPACE_ROOT, target)) {
    throw new SandboxError(OUTSIDE_MESSAGE);
  }
  if (target === WORKSPACE_ROOT && !options.allowRoot) {
    throw new SandboxError("Path must point to a file or folder inside the workspace, not the workspace itself.");
  }

  // 4. Symlink / junction check. Walk up from the target until we find
  // something that exists, then make sure its real location is inside the
  // real workspace. This stops a link inside the workspace from leading outside.
  const realRoot = await fs.realpath(WORKSPACE_ROOT);
  let probe = target;
  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      if (!isInside(realRoot, realProbe)) {
        throw new SandboxError(OUTSIDE_MESSAGE);
      }
      break;
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;

      // realpath failed because something doesn't exist. If `probe` is a
      // dangling symlink, it still points somewhere we can't verify: refuse it.
      try {
        await fs.lstat(probe);
        throw new SandboxError(OUTSIDE_MESSAGE);
      } catch (lstatErr) {
        if (lstatErr instanceof SandboxError) throw lstatErr;
      }

      const parent = path.dirname(probe);
      if (parent === probe) throw new SandboxError(OUTSIDE_MESSAGE);
      probe = parent;
    }
  }

  return target;
}

// ---------------------------------------------------------------------------
// Small helpers for tool results and errors
// ---------------------------------------------------------------------------

// Path shown to the client: always relative to the workspace, with "/" separators.
function displayPath(absolutePath: string): string {
  const rel = path.relative(WORKSPACE_ROOT, absolutePath);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// Convert any error into a clear MCP tool error WITHOUT leaking absolute paths.
function fail(err: unknown, kind: "File" | "Directory" = "File"): CallToolResult {
  let message: string;
  if (err instanceof SandboxError) {
    message = err.message;
  } else {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    switch (code) {
      case "ENOENT":
        message = `${kind} does not exist.`;
        break;
      case "ENOTDIR":
        message = "A part of the path is not a directory.";
        break;
      case "EISDIR":
        message = "That path is a directory, not a file.";
        break;
      case "EACCES":
      case "EPERM":
        message = "Permission denied.";
        break;
      default:
        message = "The file operation failed.";
    }
  }
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

// Make sure a path is a regular file that is small enough to handle.
async function assertReadableFile(target: string): Promise<void> {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new SandboxError("That path is not a file.");
  if (stat.size > MAX_FILE_BYTES) {
    throw new SandboxError("File is too large (limit is 1 MB).");
  }
}

// ---------------------------------------------------------------------------
// MCP server + tools (M2: exactly five tools)
// ---------------------------------------------------------------------------

// Build a new MCP server with the five file tools registered.
// Used by both entry points: server.ts (stdio) creates one for its single
// connection, and server-http.ts creates a fresh one for every HTTP request.
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mcp-file-server",
    version: "0.3.0",
  });

  // 1. list_files
  server.registerTool(
    "list_files",
    {
      description:
        "List the files and folders inside the workspace. " +
        "Optionally pass a sub-folder path relative to the workspace root (default: '.').",
      inputSchema: {
        path: z
          .string()
          .max(1000)
          .default(".")
          .describe("Folder relative to the workspace root, e.g. '.' or 'projects'."),
      },
    },
    async ({ path: userPath }) => {
      try {
        const target = await resolveSafePath(userPath, { allowRoot: true });
        const entries = await fs.readdir(target, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${e.isDirectory() ? "[dir] " : "[file]"} ${e.name}`);

        const label = displayPath(target);
        return ok(
          lines.length > 0
            ? `Contents of workspace/${label}:\n${lines.join("\n")}`
            : `workspace/${label} is empty.`
        );
      } catch (err) {
        return fail(err, "Directory");
      }
    }
  );

  // 2. read_file
  server.registerTool(
    "read_file",
    {
      description: "Read a text file inside the workspace and return its contents.",
      inputSchema: {
        path: z.string().min(1).max(1000).describe("File path relative to the workspace root, e.g. 'notes.txt'."),
      },
    },
    async ({ path: userPath }) => {
      try {
        const target = await resolveSafePath(userPath);
        await assertReadableFile(target);
        return ok(await fs.readFile(target, "utf8"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 3. write_file
  server.registerTool(
    "write_file",
    {
      description:
        "Create a text file in the workspace, or overwrite it if it already exists. " +
        "Missing parent folders (inside the workspace) are created automatically.",
      inputSchema: {
        path: z.string().min(1).max(1000).describe("File path relative to the workspace root, e.g. 'folder/notes.txt'."),
        content: z.string().describe("The full text content to write."),
      },
    },
    async ({ path: userPath, content }) => {
      try {
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          throw new SandboxError("Content is too large (limit is 1 MB).");
        }
        const target = await resolveSafePath(userPath); // security check FIRST

        const existed = await fs.stat(target).then(
          () => true,
          () => false
        );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return ok(`${existed ? "Overwrote" : "Created"} workspace/${displayPath(target)} (${content.length} characters).`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 4. str_replace
  // Behavior: `old` must match EXACTLY ONE place in the file. If it matches zero
  // or several places, nothing is changed and an error explains why.
  server.registerTool(
    "str_replace",
    {
      description:
        "Replace one exact piece of text in a workspace file. " +
        "'old' must appear exactly once; if it is missing or appears more than once, nothing is changed.",
      inputSchema: {
        path: z.string().min(1).max(1000).describe("File path relative to the workspace root."),
        old: z.string().describe("The exact text to find (must match exactly once)."),
        new: z.string().describe("The text to put in its place (may be empty to delete 'old')."),
      },
    },
    async ({ path: userPath, old, new: replacement }) => {
      try {
        if (old === "") {
          throw new SandboxError("'old' must not be empty.");
        }
        const target = await resolveSafePath(userPath);
        await assertReadableFile(target);
        const text = await fs.readFile(target, "utf8");

        // Count matches (non-overlapping) without using regular expressions.
        let count = 0;
        let first = -1;
        for (let i = text.indexOf(old); i !== -1; i = text.indexOf(old, i + old.length)) {
          if (count === 0) first = i;
          count++;
        }
        if (count === 0) {
          throw new SandboxError("The 'old' text was not found in the file. No changes were made.");
        }
        if (count > 1) {
          throw new SandboxError(
            `The 'old' text appears ${count} times. Use a longer, unique piece of text. No changes were made.`
          );
        }

        const updated = text.slice(0, first) + replacement + text.slice(first + old.length);
        if (Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES) {
          throw new SandboxError("The result would be too large (limit is 1 MB). No changes were made.");
        }
        await fs.writeFile(target, updated, "utf8");
        return ok(`Replaced 1 occurrence in workspace/${displayPath(target)}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 5. delete_file
  server.registerTool(
    "delete_file",
    {
      description: "Delete a single file inside the workspace. Folders cannot be deleted.",
      inputSchema: {
        path: z.string().min(1).max(1000).describe("File path relative to the workspace root."),
      },
    },
    async ({ path: userPath }) => {
      try {
        const target = await resolveSafePath(userPath);
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          throw new SandboxError("Only files can be deleted, not folders.");
        }
        await fs.unlink(target);
        return ok(`Deleted workspace/${displayPath(target)}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}

// Make sure the workspace folder exists.
export async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
}