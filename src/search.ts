// M4: search_files. Find text inside files (or file names) in the workspace.
//
// Safety:
//   - The start folder goes through resolveSafePath(), the same sandbox as every other tool.
//   - Symbolic links are never followed, so a link cannot lead the search outside workspace/.
//   - Plain text search only (no regular expressions): a malicious pattern could
//     otherwise freeze the whole server.
//   - Hard limits on results, files, bytes, depth and time keep the output small and the search quick.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES, SandboxError, displayPath, fail, ok, resolveSafePath } from "./tools.js";

const MAX_FILES_SCANNED = 2000;
const MAX_DEPTH = 20;
const MAX_BYTES_SCANNED = 20 * 1024 * 1024;
const MAX_SECONDS = 5;
const MAX_MATCHES_PER_FILE = 10;
const SNIPPET_LENGTH = 200;
const MAX_OUTPUT_CHARS = 20_000;
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

type Match = { file: string; line: number; text: string };

type Progress = {
  files: number;
  bytes: number;
  tooLarge: number;
  binary: number;
  links: number;
  matches: Match[];
  names: string[];
  stoppedBecause: string | null;
};

// A short piece of the line around the match.
function snippet(line: string, column: number): string {
  const start = Math.max(0, column - 60);
  const piece = line.slice(start, start + SNIPPET_LENGTH).trim();
  return `${start > 0 ? "…" : ""}${piece}${start + SNIPPET_LENGTH < line.length ? "…" : ""}`;
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "search_files",
    {
      description:
        "Search the workspace for text. mode 'content' (default) finds lines containing the text and returns file:line: snippet. " +
        "mode 'filename' finds files and folders whose NAME contains the text. Plain text only (no regular expressions). " +
        "Folders named .git and node_modules, symbolic links, binary files and files over 1 MB are skipped.",
      inputSchema: z.strictObject({
        query: z.string().min(1).max(200).describe("The text to look for (one line)."),
        path: z.string().max(1000).default(".").describe("File or folder to search in, relative to the workspace root (default: '.')."),
        mode: z.enum(["content", "filename"]).default("content").describe("Search inside files, or search file names."),
        case_sensitive: z.boolean().default(false).describe("true = match upper/lower case exactly."),
        max_results: z.number().int().min(1).max(200).default(50).describe("Stop after this many results (1-200)."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, path: userPath, mode, case_sensitive, max_results }) => {
      try {
        if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(query)) {
          throw new SandboxError("The search text must be a single line without control characters.");
        }
        const start = await resolveSafePath(userPath, { allowRoot: true }); // the sandbox check
        const info = await fs.stat(start).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT" || err.code === "ENOTDIR") throw new SandboxError("Path does not exist.");
          throw err;
        });

        const needle = case_sensitive ? query : query.toLowerCase();
        const fold = (text: string) => (case_sensitive ? text : text.toLowerCase());
        const deadline = Date.now() + MAX_SECONDS * 1000;
        const progress: Progress = { files: 0, bytes: 0, tooLarge: 0, binary: 0, links: 0, matches: [], names: [], stoppedBecause: null };
        const resultCount = () => (mode === "content" ? progress.matches.length : progress.names.length);

        // Returns false when the search must stop.
        const keepGoing = (): boolean => {
          if (progress.stoppedBecause) return false;
          if (resultCount() >= max_results) progress.stoppedBecause = `reached ${max_results} results`;
          else if (progress.files >= MAX_FILES_SCANNED) progress.stoppedBecause = `scanned ${MAX_FILES_SCANNED} files`;
          else if (progress.bytes >= MAX_BYTES_SCANNED) progress.stoppedBecause = "scanned 20 MB of text";
          else if (Date.now() > deadline) progress.stoppedBecause = `${MAX_SECONDS} second time limit`;
          return progress.stoppedBecause === null;
        };

        const searchFile = async (file: string): Promise<void> => {
          progress.files++;
          const stat = await fs.stat(file);
          if (stat.size > MAX_FILE_BYTES) {
            progress.tooLarge++;
            return;
          }
          const buffer = await fs.readFile(file);
          progress.bytes += buffer.length;
          if (buffer.subarray(0, 8000).includes(0)) {
            progress.binary++;
            return;
          }
          let inThisFile = 0;
          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && inThisFile < MAX_MATCHES_PER_FILE && keepGoing(); i++) {
            const line = lines[i]!;
            const column = fold(line).indexOf(needle);
            if (column === -1) continue;
            inThisFile++;
            progress.matches.push({ file: displayPath(file), line: i + 1, text: snippet(line, column) });
          }
        };

        const walk = async (folder: string, depth: number): Promise<void> => {
          const entries = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (!keepGoing()) return;
            const full = path.join(folder, entry.name);
            if (entry.isSymbolicLink()) {
              progress.links++; // never follow links
              continue;
            }
            const nameMatches = fold(entry.name).includes(needle);
            if (entry.isDirectory()) {
              if (SKIPPED_FOLDERS.has(entry.name)) continue;
              if (mode === "filename" && nameMatches) progress.names.push(`[dir]  ${displayPath(full)}/`);
              if (depth < MAX_DEPTH) await walk(full, depth + 1);
            } else if (entry.isFile()) {
              if (mode === "filename") {
                progress.files++;
                if (nameMatches) progress.names.push(`[file] ${displayPath(full)}`);
              } else {
                await searchFile(full);
              }
            }
          }
        };

        if (info.isDirectory()) await walk(start, 0);
        else if (info.isFile()) {
          if (mode === "content") await searchFile(start);
          else if (fold(path.basename(start)).includes(needle)) progress.names.push(`[file] ${displayPath(start)}`);
        } else {
          throw new SandboxError("That path is neither a file nor a folder.");
        }

        // ---- build the answer ----
        const where = `workspace/${displayPath(start) === "." ? "" : displayPath(start)}`;
        const caseNote = case_sensitive ? "case-sensitive" : "case-insensitive";
        const lines: string[] = [];
        if (mode === "content") {
          const fileCount = new Set(progress.matches.map((m) => m.file)).size;
          lines.push(
            progress.matches.length === 0
              ? `No matches for "${query}" in ${where} (${caseNote}, ${progress.files} files searched).`
              : `${progress.matches.length} match(es) in ${fileCount} file(s) for "${query}" in ${where} (${caseNote}):`
          );
          for (const m of progress.matches) lines.push(`${m.file}:${m.line}: ${m.text}`);
        } else {
          lines.push(
            progress.names.length === 0
              ? `No file or folder names contain "${query}" in ${where} (${caseNote}).`
              : `${progress.names.length} name(s) containing "${query}" in ${where} (${caseNote}):`
          );
          lines.push(...progress.names);
        }

        const notes: string[] = [];
        if (progress.stoppedBecause) notes.push(`search stopped early: ${progress.stoppedBecause}`);
        if (progress.tooLarge > 0) notes.push(`${progress.tooLarge} file(s) over 1 MB skipped`);
        if (progress.binary > 0) notes.push(`${progress.binary} binary file(s) skipped`);
        if (progress.links > 0) notes.push(`${progress.links} symbolic link(s) not followed`);
        if (notes.length > 0) lines.push(`[${notes.join("; ")}]`);

        const text = lines.join("\n");
        return ok(text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[Output shortened.]` : text);
      } catch (err) {
        return fail(err);
      }
    }
  );
}