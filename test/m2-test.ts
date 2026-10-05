// M2 test script: starts the real MCP server over stdio and calls its tools
// like an MCP client would. Run it with:  npm test
//
// SAFETY: the tests never run against your real project. They copy it into a
// temporary folder and start the server from that copy, so even if the sandbox
// had a bug, the "attacks" below could only damage the throwaway copy and a
// harmless sentinel file, never your real files. Everything is deleted at the end.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// The real project (only READ from, never written to).
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The throwaway copy that the server runs from (set up in main()).
let projectRoot = "";
let workspace = "";
let testDirAbs = "";
const TEST_DIR = "_m2_test";

// ---- tiny test helpers ------------------------------------------------------

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? "  -> " + detail : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

type Result = { isError: boolean; text: string };

let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  try {
    const r = await client.callTool({ name, arguments: args });
    const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
    return { isError: r.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
  } catch (err) {
    // Input-validation failures may come back as protocol errors: treat as rejected.
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

async function sha(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const readDisk = (rel: string) => fs.readFile(path.join(workspace, rel), "utf8");

// ---- the tests --------------------------------------------------------------

async function main(): Promise<void> {
  // --- Build the throwaway copy of the project -------------------------------
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-m2-test-"));
  projectRoot = path.join(tmpBase, "project");
  workspace = path.join(projectRoot, "workspace");
  testDirAbs = path.join(workspace, TEST_DIR);
  await fs.mkdir(workspace, { recursive: true });
  await fs.cp(path.join(sourceRoot, "src"), path.join(projectRoot, "src"), { recursive: true });
  await fs.copyFile(path.join(sourceRoot, "package.json"), path.join(projectRoot, "package.json"));
  await fs.copyFile(path.join(sourceRoot, "tsconfig.json"), path.join(projectRoot, "tsconfig.json"));
  // Reuse the installed packages through a link (read-only use).
  const nodeModulesLink = path.join(projectRoot, "node_modules");
  await fs.symlink(
    path.join(sourceRoot, "node_modules"),
    nodeModulesLink,
    process.platform === "win32" ? "junction" : "dir"
  );

  // A harmless file OUTSIDE the project copy. Absolute-path attacks aim at it.
  const sentinel = path.join(tmpBase, "outside-sentinel.txt");
  await fs.writeFile(sentinel, "SENTINEL");

  // Hashes of the REAL project's key files, to prove the tests never touch them.
  const realFiles = ["package.json", "tsconfig.json", path.join("src", "server.ts")].map((f) => path.join(sourceRoot, f));
  const realBefore = new Map<string, string>();
  for (const f of realFiles) realBefore.set(f, await sha(f));

  // --- Start the server from the copy, as an MCP client would ----------------
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: ["--import", "tsx", path.join(projectRoot, "src", "server.ts")],
    cwd: projectRoot,
    stderr: "ignore",
  });
  client = new Client({ name: "m2-test-client", version: "1.0.0" });
  await client.connect(transport);

  // Files in the copy (outside workspace/) that must NEVER change.
  const protectedFiles = [
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "tsconfig.json"),
    path.join(projectRoot, "src", "server.ts"),
  ];
  const before = new Map<string, string>();
  for (const f of protectedFiles) before.set(f, await sha(f));

  try {
    // -------------------------------------------------------------------------
    section("Tool registration");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    check(
      "exactly the five M2 tools are registered",
      JSON.stringify(tools) === JSON.stringify(["delete_file", "list_files", "read_file", "str_replace", "write_file"]),
      tools.join(", ")
    );

    // -------------------------------------------------------------------------
    section("TEST 1: list_files('.')");
    let r = await call("list_files", { path: "." });
    check("list_files('.') succeeds", !r.isError && r.text.includes("workspace/."), r.text);
    r = await call("list_files", {});
    check("list_files with no path defaults to the workspace", !r.isError && r.text.includes("workspace/."), r.text);

    // -------------------------------------------------------------------------
    section("TEST 2: write_file");
    r = await call("write_file", { path: `${TEST_DIR}/notes.txt`, content: "Hello MCP" });
    check("write_file creates a file", !r.isError && r.text.startsWith("Created"), r.text);
    check("file exists on disk inside workspace with the right content", (await readDisk(`${TEST_DIR}/notes.txt`)) === "Hello MCP");
    r = await call("list_files", { path: "." });
    check("list_files('.') now shows the test folder", r.text.includes(TEST_DIR), r.text);
    r = await call("list_files", { path: TEST_DIR });
    check("list_files(test folder) shows notes.txt", r.text.includes("[file] notes.txt"), r.text);

    // -------------------------------------------------------------------------
    section("TEST 3: read_file");
    r = await call("read_file", { path: `${TEST_DIR}/notes.txt` });
    check("read_file returns the correct contents", !r.isError && r.text === "Hello MCP", r.text);

    // -------------------------------------------------------------------------
    section("TEST 4: str_replace");
    r = await call("str_replace", { path: `${TEST_DIR}/notes.txt`, old: "MCP", new: "World" });
    check("str_replace succeeds", !r.isError, r.text);
    check("only the requested text changed ('Hello World')", (await readDisk(`${TEST_DIR}/notes.txt`)) === "Hello World");

    r = await call("str_replace", { path: `${TEST_DIR}/notes.txt`, old: "NOPE", new: "x" });
    check("str_replace with missing 'old' text is an error", r.isError && r.text.includes("not found"), r.text);
    check("...and the file is unchanged", (await readDisk(`${TEST_DIR}/notes.txt`)) === "Hello World");

    await call("write_file", { path: `${TEST_DIR}/multi.txt`, content: "a a a" });
    r = await call("str_replace", { path: `${TEST_DIR}/multi.txt`, old: "a", new: "b" });
    check("str_replace with several matches is rejected as ambiguous", r.isError && r.text.includes("3 times"), r.text);
    check("...and the file is unchanged", (await readDisk(`${TEST_DIR}/multi.txt`)) === "a a a");

    r = await call("str_replace", { path: `${TEST_DIR}/multi.txt`, old: "", new: "b" });
    check("str_replace with empty 'old' is rejected", r.isError, r.text);

    // -------------------------------------------------------------------------
    section("Allowed paths (should all work)");
    for (const rel of [
      `${TEST_DIR}/folder/notes.txt`,
      `${TEST_DIR}/projects/test.txt`,
      `${TEST_DIR}/data/example.txt`,
      `${TEST_DIR}/./sub/../inside.txt`, // ".." that stays inside the workspace
    ]) {
      r = await call("write_file", { path: rel, content: "ok" });
      check(`write_file('${rel}') allowed`, !r.isError, r.text);
    }
    check("nested folders were created inside the workspace", await exists(path.join(testDirAbs, "folder", "notes.txt")));
    check("'sub/../inside.txt' normalised to a file inside the workspace", await exists(path.join(testDirAbs, "inside.txt")));

    // -------------------------------------------------------------------------
    section("Ordinary errors (clear, and no absolute system paths leaked)");
    const errorCases: Array<[string, string, Record<string, unknown>]> = [
      ["read_file on a missing file", "read_file", { path: `${TEST_DIR}/missing.txt` }],
      ["list_files on a missing folder", "list_files", { path: `${TEST_DIR}/missing-folder` }],
      ["read_file on a folder", "read_file", { path: TEST_DIR }],
      ["delete_file on a missing file", "delete_file", { path: `${TEST_DIR}/missing.txt` }],
      ["delete_file on a folder", "delete_file", { path: TEST_DIR }],
      ["write_file onto a folder", "write_file", { path: TEST_DIR, content: "x" }],
      ["read_file on the workspace root itself", "read_file", { path: "." }],
      ["read_file with an empty path", "read_file", { path: "" }],
      ["read_file with a null byte in the path", "read_file", { path: "a\0b.txt" }],
    ];
    for (const [label, tool, args] of errorCases) {
      r = await call(tool, args);
      const leaks = r.text.includes(projectRoot) || r.text.includes(workspace);
      check(`${label} -> error`, r.isError && !leaks, r.text);
    }
    check("the test folder survived the 'delete folder' attempt", await exists(testDirAbs));

    // -------------------------------------------------------------------------
    section("TEST 5: delete_file");
    r = await call("delete_file", { path: `${TEST_DIR}/notes.txt` });
    check("delete_file succeeds", !r.isError, r.text);
    check("the file is gone from disk", !(await exists(path.join(testDirAbs, "notes.txt"))));

    // -------------------------------------------------------------------------
    section("SECURITY: path traversal and absolute paths (every tool, every path)");
    const attackPaths: string[] = [
      "../package.json",
      "../../package.json",
      "../src/server.ts",
      "../../src/server.ts",
      "folder/../../package.json",
      `${TEST_DIR}/../../package.json`,
      "a/b/../../../package.json",
      "../workspace/../package.json",
      "..",
      "../..",
      "../src",
    ];
    const absoluteAttackPaths: string[] = [
      path.join(projectRoot, "package.json"),
      path.join(projectRoot, "src", "server.ts"),
      path.join(projectRoot, "src"),
      sentinel, // absolute path to a harmless file outside the project copy
    ];
    if (process.platform === "win32") {
      // Windows-style separators (only meaningful when the server runs on Windows).
      attackPaths.push("..\\package.json", "..\\..\\src\\server.ts", "folder\\..\\..\\package.json");
    }

    const isRejection = (res: Result) =>
      res.isError && (res.text.includes("outside the workspace") || res.text.includes("Absolute paths"));

    for (const p of [...attackPaths, ...absoluteAttackPaths]) {
      const results: Array<[string, Result]> = [
        ["list_files", await call("list_files", { path: p })],
        ["read_file", await call("read_file", { path: p })],
        ["write_file", await call("write_file", { path: p, content: "HACKED" })],
        ["str_replace", await call("str_replace", { path: p, old: "{", new: "HACKED" })],
        ["delete_file", await call("delete_file", { path: p })],
      ];
      for (const [tool, res] of results) {
        check(`${tool}(${JSON.stringify(p)}) rejected`, isRejection(res), res.text);
      }
    }

    // -------------------------------------------------------------------------
    section("SECURITY: symlinks / junctions that lead outside the workspace");
    let linksSupported = true;
    try {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(path.join(projectRoot, "src"), path.join(testDirAbs, "link_to_src"), linkType);
      // A symlink whose target does not exist (dangling): writing through it would create a file outside.
      await fs.symlink(
        path.join(projectRoot, "created_by_attack.txt"),
        path.join(testDirAbs, "dangling.txt"),
        "file"
      );
    } catch {
      linksSupported = false;
      console.log("  SKIP  could not create symlinks on this system (needs permission on Windows)");
    }
    if (linksSupported) {
      r = await call("list_files", { path: `${TEST_DIR}/link_to_src` });
      check("list_files through a link to ../src rejected", isRejection(r), r.text);
      r = await call("read_file", { path: `${TEST_DIR}/link_to_src/server.ts` });
      check("read_file through the link rejected", isRejection(r), r.text);
      r = await call("write_file", { path: `${TEST_DIR}/link_to_src/evil.txt`, content: "HACKED" });
      check("write_file through the link rejected", isRejection(r), r.text);
      check("...and nothing was created in src/", !(await exists(path.join(projectRoot, "src", "evil.txt"))));
      r = await call("delete_file", { path: `${TEST_DIR}/link_to_src/server.ts` });
      check("delete_file through the link rejected", isRejection(r), r.text);
      r = await call("write_file", { path: `${TEST_DIR}/dangling.txt`, content: "HACKED" });
      check("write_file through a dangling link rejected", isRejection(r), r.text);
      check("...and nothing was created outside the workspace", !(await exists(path.join(projectRoot, "created_by_attack.txt"))));
    }

    // -------------------------------------------------------------------------
    section("SECURITY: project files outside workspace/ are untouched");
    for (const f of protectedFiles) {
      check(`${path.relative(projectRoot, f)} still exists`, await exists(f));
      check(`${path.relative(projectRoot, f)} content unchanged`, (await exists(f)) && (await sha(f)) === before.get(f));
    }
    check(
      "the sentinel file outside the project still exists and is unchanged",
      (await exists(sentinel)) && (await fs.readFile(sentinel, "utf8")) === "SENTINEL"
    );
    for (const f of realFiles) {
      check(`REAL project file ${path.relative(sourceRoot, f)} was never touched`, (await exists(f)) && (await sha(f)) === realBefore.get(f));
    }
  } finally {
    // Cleanup: remove links first (so nothing can be followed), then the whole temp folder.
    await client.close().catch(() => {});
    for (const link of [path.join(testDirAbs, "link_to_src"), path.join(testDirAbs, "dangling.txt"), nodeModulesLink]) {
      await fs.unlink(link).catch(() => {});
    }
    await fs.rm(tmpBase, { recursive: true, force: true });
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});