// M4 test script: handoff tools, git-lite tools and search_files.  Run it with:  npm run test:m4
//
// It starts the real HTTP server (and, for one section, the stdio server) and calls
// the tools like an MCP client would.
//
// SAFETY (same idea as the M2 and M3 tests): everything runs from a throwaway COPY of
// the project in a temp folder. The "attacks" can only ever touch that copy and
// harmless files next to it (a sentinel file and a "canary" folder), never your
// real project. Git repositories used here are created inside the temp folder too.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tmpBase = "";
let projectRoot = "";
let workspace = "";

const EXPECTED_TOOLS = [
  "delete_file", "git_diff", "git_log", "git_status", "list_files", "read_checkpoints", "read_decisions",
  "read_file", "read_plan_log", "read_project_state", "record_checkpoint", "record_decision",
  "search_files", "str_replace", "update_plan_log", "update_project_state", "write_file",
];
const NEW_TOOLS = EXPECTED_TOOLS.filter((t) => !["delete_file", "list_files", "read_file", "str_replace", "write_file"].includes(t));

// ---- tiny test helpers ------------------------------------------------------

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? "  -> " + detail.slice(0, 400) : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

type Result = { isError: boolean; text: string };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  try {
    const r = await client.callTool({ name, arguments: args });
    const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
    return { isError: r.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
  } catch (err) {
    // Input-validation failures may come back as protocol errors: treat as rejected.
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

const sha = async (file: string) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const countLines = (text: string, re: RegExp) => text.split("\n").filter((l) => re.test(l)).length;
const isRejection = (x: Result) => x.isError && (x.text.includes("outside the workspace") || x.text.includes("Absolute paths"));

// Runs git in the temp copy (this is the TEST talking to git, not the server).
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test-author@example.invalid",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test-author@example.invalid",
    },
  });
}

// ---- running a server as a child process -------------------------------------

type RunningServer = { child: ChildProcess; output: () => string; exited: Promise<number | null> };

function startServer(env: NodeJS.ProcessEnv = {}): RunningServer {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "server-http.ts")], {
    cwd: projectRoot,
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => out, exited };
}

async function waitForPort(server: RunningServer): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const m = server.output().match(/listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/);
    if (m) return Number(m[1]);
    await sleep(100);
  }
  throw new Error("Server did not start. Output:\n" + server.output());
}

async function newClient(port: number): Promise<Client> {
  const client = new Client({ name: "m4-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

// ---- the tests --------------------------------------------------------------

async function main(): Promise<void> {
  // The real project is only READ from.
  const realFiles = [
    "package.json", "tsconfig.json", path.join("src", "tools.ts"), path.join("src", "handoff.ts"), path.join("src", "git-tools.ts"),
    path.join("src", "search.ts"), path.join("workspace", "PROJECT_STATE.md"), path.join("workspace", "PLAN_LOG.md"),
    path.join("workspace", "CHECKPOINTS.md"), path.join("workspace", "DECISIONS.md"),
  ].map((f) => path.join(sourceRoot, f));
  const realBefore = new Map<string, string>();
  for (const f of realFiles) realBefore.set(f, await sha(f));

  // Throwaway copy of the project.
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-m4-test-"));
  projectRoot = path.join(tmpBase, "project");
  workspace = path.join(projectRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.cp(path.join(sourceRoot, "src"), path.join(projectRoot, "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) await fs.copyFile(path.join(sourceRoot, f), path.join(projectRoot, f));
  // The real handoff files are copied in, so the tests read the REAL content and structure.
  for (const f of ["PROJECT_STATE.md", "PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]) {
    await fs.copyFile(path.join(sourceRoot, "workspace", f), path.join(workspace, f));
  }
  const nodeModulesLink = path.join(projectRoot, "node_modules");
  await fs.symlink(path.join(sourceRoot, "node_modules"), nodeModulesLink, process.platform === "win32" ? "junction" : "dir");

  // Harmless things OUTSIDE the project that attacks will aim at.
  const sentinel = path.join(tmpBase, "outside-sentinel.txt");
  await fs.writeFile(sentinel, "SENTINEL-OUTSIDE");
  const outsideDir = path.join(tmpBase, "outside-dir");
  await fs.mkdir(outsideDir);
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "OUTSIDE-SECRET-MARKER");
  const canaryDir = path.join(tmpBase, "canary"); // injection attempts try to create files here
  await fs.mkdir(canaryDir);
  const canary = (n: number) => path.join(canaryDir, `pwned${n}.txt`);

  const server = startServer();
  let client: Client | undefined;
  let noGitServer: RunningServer | undefined;
  let noGitClient: Client | undefined;
  let stdioClient: Client | undefined;
  const linksToRemove: string[] = [nodeModulesLink];

  try {
    const port = await waitForPort(server);
    client = await newClient(port);
    const c = client;
    const readDisk = (rel: string) => fs.readFile(path.join(workspace, rel), "utf8");

    // =========================================================================
    section("Startup and tool list (HTTP server from M3 still starts)");
    check("HTTP server started on 127.0.0.1 and reported its address", port > 0, server.output());
    check("it still serves the endpoint /mcp", /\/mcp\n/.test(server.output()));
    const toolList = (await c.listTools()).tools;
    const names = toolList.map((t) => t.name).sort();
    check("exactly the expected 17 tools are registered", JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(", "));
    check("the five M1/M2 core tools are all still there", ["list_files", "read_file", "write_file", "str_replace", "delete_file"].every((t) => names.includes(t)));
    check("there is no run/exec/shell/command tool", !names.some((n) => /(^|_)(run|exec|shell|command|cmd|bash|eval)(_|$)/.test(n)), names.join(", "));
    check("the only git tools are git_status, git_diff and git_log (nothing that changes the repository)", JSON.stringify(names.filter((n) => n.startsWith("git"))) === JSON.stringify(["git_diff", "git_log", "git_status"]));
    check(
      "every new tool refuses unknown arguments (strict input schema)",
      NEW_TOOLS.every((n) => (toolList.find((t) => t.name === n)?.inputSchema as { additionalProperties?: unknown }).additionalProperties === false),
      JSON.stringify(toolList.map((t) => [t.name, (t.inputSchema as { additionalProperties?: unknown }).additionalProperties]))
    );

    // =========================================================================
    section("Handoff: the four files can be read");
    let r = await call(c, "read_project_state");
    check("read_project_state returns PROJECT_STATE.md", !r.isError && r.text.includes("# Project State") && r.text.includes("## Current milestone") && r.text.includes("MCP File Server"), r.text);
    r = await call(c, "read_plan_log");
    check("read_plan_log returns PLAN_LOG.md", !r.isError && r.text.includes("# Plan Log") && r.text.includes("## Current step"), r.text);
    r = await call(c, "read_checkpoints");
    check("read_checkpoints returns CHECKPOINTS.md (M1, M2, M3 recorded)", !r.isError && r.text.includes("## M1 — completed") && r.text.includes("## M2 — completed") && r.text.includes("## M3 — completed"), r.text);
    r = await call(c, "read_decisions");
    check("read_decisions returns DECISIONS.md", !r.isError && r.text.includes("# Decisions") && r.text.includes("## D-001"), r.text);

    // =========================================================================
    section("Handoff: updates work");
    const stateBefore = await readDisk("PROJECT_STATE.md");
    const headingsBefore = countLines(stateBefore, /^## /);
    r = await call(c, "update_project_state", { section: "Current status", content: "TEST-STATUS-1\nsecond line", agent: "test-agent-1" });
    check("update_project_state succeeds", !r.isError, r.text);
    let state = await readDisk("PROJECT_STATE.md");
    check("the section was replaced on disk", state.includes("TEST-STATUS-1\nsecond line") && !state.includes("M4 is implemented. Automated tests"));
    check("other sections are untouched and the section count is the same", countLines(state, /^## /) === headingsBefore && state.includes("## Implemented so far") && state.includes("`bbc1f56`"));
    check("the 'Last updated' line shows the agent label", /^_Last updated: \d{4}-\d\d-\d\d \d\d:\d\d UTC by test-agent-1_$/m.test(state), state.slice(0, 200));
    r = await call(c, "read_project_state");
    check("read_project_state now shows the new text", r.text.includes("TEST-STATUS-1"));

    r = await call(c, "update_plan_log", { kind: "current", text: "CURRENT-STEP-A", agent: "test-agent-1" });
    check("update_plan_log (current) works", !r.isError, r.text);
    await call(c, "update_plan_log", { kind: "current", text: "CURRENT-STEP-B" });
    await call(c, "update_plan_log", { kind: "next", text: "NEXT-STEP-X" });
    await call(c, "update_plan_log", { kind: "planned", text: "PLANNED-ONE" });
    await call(c, "update_plan_log", { kind: "planned", text: "PLANNED-TWO\nwith a second line", agent: "test-agent-2" });
    await call(c, "update_plan_log", { kind: "completed", text: "DONE-ONE" });
    await call(c, "update_plan_log", { kind: "note", text: "NOTE-ONE" });
    const plan = await readDisk("PLAN_LOG.md");
    check("'current' replaces (A is gone, B is there) and 'next' is set", plan.includes("CURRENT-STEP-B") && !plan.includes("CURRENT-STEP-A") && plan.includes("NEXT-STEP-X"));
    check("'planned' appends (both entries kept, with agent and time)", plan.includes("PLANNED-ONE") && /- \[\d{4}-\d\d-\d\d \d\d:\d\d UTC\] \(test-agent-2\) PLANNED-TWO\n {2}with a second line/.test(plan));
    check("'completed' and 'note' append to their own lists, the old history stays", plan.includes("DONE-ONE") && plan.includes("NOTE-ONE") && plan.includes("M1: MCP server skeleton"));
    check("PLAN_LOG.md still has exactly its 5 sections", countLines(plan, /^## /) === 5, String(countLines(plan, /^## /)));

    r = await call(c, "record_checkpoint", { name: "M4 test checkpoint", status: "in_progress", notes: "CHECKPOINT-NOTE\nline two", testing: "TESTING-NOTE", agent: "test-agent-1" });
    check("record_checkpoint succeeds", !r.isError, r.text);
    await call(c, "record_checkpoint", { name: "second checkpoint", status: "completed", notes: "no testing field" });
    const cps = await readDisk("CHECKPOINTS.md");
    check("checkpoints are appended after the old ones, in order", cps.indexOf("## M3 — completed") < cps.indexOf("## M4 test checkpoint — in_progress") && cps.indexOf("## M4 test checkpoint") < cps.indexOf("## second checkpoint — completed"));
    check("checkpoint entries contain notes, testing and who/when", cps.includes("- Notes: CHECKPOINT-NOTE\n  line two") && cps.includes("- Testing: TESTING-NOTE") && cps.includes("by test-agent-1"));
    check("the second checkpoint has no Testing line", !/second checkpoint — completed\n- Recorded.*\n- Notes: no testing field\n- Testing/.test(cps));

    r = await call(c, "record_decision", { title: "TEST-DECISION-ONE", decision: "decide A", reason: "because A", agent: "test-agent-1" });
    check("record_decision succeeds and gets the next number (D-009)", !r.isError && r.text.includes("D-009"), r.text);
    r = await call(c, "record_decision", { title: "TEST-DECISION-TWO", decision: "decide B", reason: "because B" });
    check("the next decision is D-010", !r.isError && r.text.includes("D-010"), r.text);
    const decisions = await readDisk("DECISIONS.md");
    check("decisions are on disk with decision and reason", decisions.includes("## D-009: TEST-DECISION-ONE") && decisions.includes("- Decision: decide A") && decisions.includes("- Reason: because A") && decisions.includes("## D-001"));

    // =========================================================================
    section("Handoff: bad input and text that tries to break the file structure");
    for (const [label, args] of [
      ["an unknown section name", { section: "Bogus", content: "x" }],
      ["empty content", { section: "Current status", content: "" }],
      ["an extra 'path' argument (../../x)", { section: "Current status", content: "x", path: "../../x" }],
      ["an agent label over 60 characters", { section: "Current status", content: "x", agent: "a".repeat(61) }],
    ] as Array<[string, Record<string, unknown>]>) {
      r = await call(c, "update_project_state", args);
      check(`update_project_state rejects ${label}`, r.isError, r.text);
    }
    r = await call(c, "record_checkpoint", { name: "x", status: "finished", notes: "x" });
    check("record_checkpoint rejects an unknown status", r.isError, r.text);
    r = await call(c, "record_decision", { title: "x", decision: "x" });
    check("record_decision rejects a missing 'reason'", r.isError, r.text);

    const before = await readDisk("PROJECT_STATE.md");
    r = await call(c, "update_project_state", { section: "Current status", content: "legit line\n## Current milestone\nHACKED MILESTONE\n# Top heading\n```\nunclosed code block", agent: "evil\n## Fake agent heading" });
    check("update with fake '##' headings and an unclosed code block succeeds", !r.isError, r.text);
    state = await readDisk("PROJECT_STATE.md");
    check("no extra section was created (heading count unchanged)", countLines(state, /^## /) === countLines(before, /^## /), String(countLines(state, /^## /)));
    check("the fake headings are escaped, shown as plain text", state.includes("\\## Current milestone") && state.includes("\\# Top heading"));
    check("the code block was closed (even number of ``` lines)", countLines(state, /^```/) % 2 === 0);
    check("a newline in the agent label cannot create a heading", !/^## Fake agent heading/m.test(state));
    r = await call(c, "update_project_state", { section: "Current milestone", content: "REAL-MILESTONE-TEXT" });
    state = await readDisk("PROJECT_STATE.md");
    check("a later update still finds the right section (file structure not corrupted)", !r.isError && state.includes("REAL-MILESTONE-TEXT") && countLines(state, /^## Current milestone/) === 1 && !state.includes("\nHACKED MILESTONE\n## "));

    r = await call(c, "record_decision", { title: "Evil\n## D-999: fake decision", decision: "x\n## D-998: another fake", reason: "y" });
    const decisions2 = await readDisk("DECISIONS.md");
    check("a decision title with a fake heading becomes plain text on one line", !r.isError && !/^## D-99[89]/m.test(decisions2) && decisions2.includes("## D-011: Evil ## D-999: fake decision"), r.text);
    r = await call(c, "record_decision", { title: "## Hijack", decision: "x", reason: "y" });
    check("leading '#' characters in a title are dropped", !r.isError && (await readDisk("DECISIONS.md")).includes("## D-012: Hijack"), r.text);

    section("Handoff: a deleted file is re-created, and parallel writes do not clobber each other");
    r = await call(c, "delete_file", { path: "DECISIONS.md" });
    check("DECISIONS.md can be deleted with delete_file (test setup)", !r.isError, r.text);
    r = await call(c, "read_decisions");
    check("read_decisions re-creates an empty skeleton instead of failing", !r.isError && r.text.includes("# Decisions") && (await exists(path.join(workspace, "DECISIONS.md"))), r.text);
    const parallel = await Promise.all(Array.from({ length: 20 }, (_, i) => call(c, "record_decision", { title: `PARALLEL-${i}`, decision: "d", reason: "r" })));
    const dec3 = await readDisk("DECISIONS.md");
    const ids = [...dec3.matchAll(/^## (D-\d+): PARALLEL-\d+$/gm)].map((m) => m[1]);
    check("20 simultaneous record_decision calls all succeeded", parallel.every((x) => !x.isError), parallel.find((x) => x.isError)?.text);
    check("all 20 are in the file, each with its own unique number", ids.length === 20 && new Set(ids).size === 20, `${ids.length} entries, ${new Set(ids).size} unique`);
    check("the numbers are consecutive D-001 ... D-020", ids.every((id, i) => id === `D-${String(i + 1).padStart(3, "0")}`), ids.join(","));

    section("Handoff: the files are protected by the sandbox (symlink pointing outside)");
    const stateFile = path.join(workspace, "PROJECT_STATE.md");
    const savedState = await fs.readFile(stateFile, "utf8");
    let symlinkOk = true;
    try {
      await fs.unlink(stateFile);
      await fs.symlink(sentinel, stateFile, "file");
    } catch {
      symlinkOk = false;
      await fs.writeFile(stateFile, savedState).catch(() => {});
      console.log("  SKIP  could not create a file symlink on this system");
    }
    if (symlinkOk) {
      r = await call(c, "read_project_state");
      check("read_project_state refuses to follow the link", isRejection(r) && !r.text.includes("SENTINEL-OUTSIDE"), r.text);
      r = await call(c, "update_project_state", { section: "Current status", content: "OVERWRITE-ATTEMPT" });
      check("update_project_state refuses to write through the link", isRejection(r), r.text);
      check("the file outside the workspace is unchanged", (await fs.readFile(sentinel, "utf8")) === "SENTINEL-OUTSIDE");
      await fs.unlink(stateFile);
      await fs.writeFile(stateFile, savedState);
    }

    // =========================================================================
    section("Existing M2 file tools still work, and the sandbox still rejects path traversal");
    r = await call(c, "write_file", { path: "_m4_core/a.txt", content: "Hello core" });
    check("write_file", !r.isError, r.text);
    r = await call(c, "read_file", { path: "_m4_core/a.txt" });
    check("read_file", !r.isError && r.text === "Hello core", r.text);
    r = await call(c, "str_replace", { path: "_m4_core/a.txt", old: "core", new: "M4" });
    check("str_replace", !r.isError && (await readDisk("_m4_core/a.txt")) === "Hello M4", r.text);
    r = await call(c, "list_files", { path: "_m4_core" });
    check("list_files", !r.isError && r.text.includes("[file] a.txt"), r.text);
    r = await call(c, "delete_file", { path: "_m4_core/a.txt" });
    check("delete_file", !r.isError && !(await exists(path.join(workspace, "_m4_core", "a.txt"))), r.text);
    for (const p of ["../package.json", "../../package.json", "folder/../../package.json", "..", "../src", path.join(projectRoot, "package.json"), sentinel]) {
      const results: Array<[string, Result]> = [
        ["list_files", await call(c, "list_files", { path: p })],
        ["read_file", await call(c, "read_file", { path: p })],
        ["write_file", await call(c, "write_file", { path: p, content: "HACKED" })],
        ["str_replace", await call(c, "str_replace", { path: p, old: "{", new: "HACKED" })],
        ["delete_file", await call(c, "delete_file", { path: p })],
      ];
      for (const [tool, out] of results) check(`${tool}(${JSON.stringify(path.isAbsolute(p) ? "<absolute path>" : p)}) rejected`, isRejection(out), out.text);
    }
    check("the sentinel file outside the project is unchanged", (await fs.readFile(sentinel, "utf8")) === "SENTINEL-OUTSIDE");

    // =========================================================================
    section("search_files: finding text");
    const T = "_m4_search";
    const put = async (rel: string, content: string | Buffer) => {
      await fs.mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
      await fs.writeFile(path.join(workspace, rel), content);
    };
    await put(`${T}/a.txt`, "alpha NeedleOne beta\nsecond line\n");
    await put(`${T}/sub/b.md`, "needleone again\nNEEDLEONE upper\r\nlast\n");
    await put(`${T}/binary.bin`, Buffer.concat([Buffer.from("needleone"), Buffer.from([0, 1, 2, 3])]));
    await put(`${T}/big.txt`, "needleone\n" + "x".repeat(1024 * 1024 + 10));
    await put(`${T}/node_modules/dep/x.txt`, "needleone in node_modules");
    await put(`${T}/.git/config`, "needleone in .git");
    await put(`${T}/regex.txt`, "a.*b\nxyz\n");
    await put(`${T}/long.txt`, "q".repeat(3000) + "LONGMARK" + "z".repeat(3000) + "\n");
    let linksOk = true;
    try {
      await fs.symlink(outsideDir, path.join(workspace, T, "link_out"), process.platform === "win32" ? "junction" : "dir");
      await fs.symlink(sentinel, path.join(workspace, T, "link_file"), "file");
      linksToRemove.push(path.join(workspace, T, "link_out"), path.join(workspace, T, "link_file"));
    } catch {
      linksOk = false;
      console.log("  SKIP  could not create symlinks on this system");
    }

    r = await call(c, "search_files", { query: "needleone", path: T });
    check("a case-insensitive search finds the matches with file:line: text", !r.isError && r.text.includes(`${T}/a.txt:1: alpha NeedleOne beta`) && r.text.includes(`${T}/sub/b.md:1: needleone again`) && r.text.includes(`${T}/sub/b.md:2: NEEDLEONE upper`), r.text);
    check("it reports 3 matches in 2 files", /^3 match\(es\) in 2 file\(s\)/.test(r.text), r.text);
    check("binary files, files over 1 MB, node_modules and .git are skipped", !r.text.includes("binary.bin:") && !r.text.includes("big.txt:") && !r.text.includes("node_modules/") && !r.text.includes(".git/") && r.text.includes("1 binary file(s) skipped") && r.text.includes("1 file(s) over 1 MB skipped"), r.text);
    if (linksOk) check("symbolic links are not followed", r.text.includes("2 symbolic link(s) not followed") && !r.text.includes("OUTSIDE-SECRET") && !r.text.includes("SENTINEL-OUTSIDE"), r.text);
    r = await call(c, "search_files", { query: "NeedleOne", path: T, case_sensitive: true });
    check("case_sensitive=true matches exactly", !r.isError && /^1 match\(es\) in 1 file\(s\)/.test(r.text) && r.text.includes("a.txt:1:"), r.text);
    r = await call(c, "search_files", { query: "no-such-text-anywhere", path: T });
    check("no match gives a clear 'No matches' message", !r.isError && r.text.startsWith("No matches"), r.text);
    r = await call(c, "search_files", { query: "needleone", path: `${T}/a.txt` });
    check("a single file can be searched", !r.isError && r.text.includes("a.txt:1:") && !r.text.includes("b.md"), r.text);
    r = await call(c, "search_files", { query: "needleone" });
    check("path defaults to the whole workspace", !r.isError && r.text.includes(`${T}/a.txt:1:`), r.text);
    r = await call(c, "search_files", { query: "b.md", path: T, mode: "filename" });
    check("mode 'filename' finds files by name", !r.isError && r.text.includes(`[file] ${T}/sub/b.md`), r.text);
    r = await call(c, "search_files", { query: "sub", path: T, mode: "filename" });
    check("mode 'filename' also finds folders", !r.isError && r.text.includes(`[dir]  ${T}/sub/`), r.text);
    r = await call(c, "search_files", { query: "PROJECT_STATE", mode: "filename" });
    check("the handoff files can be found by name", !r.isError && r.text.includes("[file] PROJECT_STATE.md"), r.text);

    section("search_files: plain text only, limits, bad input");
    r = await call(c, "search_files", { query: ".*", path: T });
    check("'.*' is matched literally, not as a regular expression", !r.isError && /^1 match\(es\) in 1 file/.test(r.text) && r.text.includes("regex.txt:1: a.*b"), r.text);
    const t0 = Date.now();
    r = await call(c, "search_files", { query: "(a+)+$", path: T });
    check("a regex-bomb pattern is harmless and fast", !r.isError && Date.now() - t0 < 3000, `${Date.now() - t0} ms: ${r.text}`);
    r = await call(c, "search_files", { query: "LONGMARK", path: T });
    const longLine = r.text.split("\n").find((l) => l.includes("long.txt:")) ?? "";
    check("a very long line is shortened to a snippet around the match", !r.isError && longLine.includes("LONGMARK") && longLine.length < 320, `${longLine.length} chars`);
    for (let i = 0; i < 30; i++) await put(`_m4_many/f${i}.txt`, "capme 1\ncapme 2\ncapme 3\n");
    r = await call(c, "search_files", { query: "capme", path: "_m4_many", max_results: 5 });
    check("max_results limits the output and says so", !r.isError && countLines(r.text, /_m4_many\/f\d+\.txt:\d+:/) === 5 && r.text.includes("reached 5 results"), r.text);
    r = await call(c, "search_files", { query: "capme", path: "_m4_many" });
    check("the default limit is 50 results", !r.isError && countLines(r.text, /_m4_many\/f\d+\.txt:\d+:/) === 50 && r.text.includes("reached 50 results"), r.text);
    check("output stays small", r.text.length < 20500, String(r.text.length));
    await put("_m4_many/one-big.txt", Array.from({ length: 100 }, (_, i) => `capme big ${i}`).join("\n"));
    r = await call(c, "search_files", { query: "capme big", path: "_m4_many/one-big.txt", max_results: 200 });
    check("one file cannot flood the results (10 matches per file)", !r.isError && countLines(r.text, /one-big\.txt:\d+:/) === 10, r.text);
    r = await call(c, "search_files", { query: "x", path: "does/not/exist" });
    check("a nonexistent path gives a clean error", r.isError && r.text.includes("Path does not exist") && !r.text.includes(projectRoot), r.text);
    for (const [label, args] of [
      ["an empty query", { query: "" }],
      ["a 201-character query", { query: "a".repeat(201) }],
      ["a query containing a newline", { query: "a\nb" }],
      ["a query containing a NUL character", { query: "a\u0000b" }],
      ["max_results 0", { query: "x", max_results: 0 }],
      ["max_results 201", { query: "x", max_results: 201 }],
      ["mode 'regex'", { query: "x", mode: "regex" }],
      ["an unknown argument 'regex'", { query: "x", regex: true }],
      ["a non-text query", { query: 123 }],
    ] as Array<[string, Record<string, unknown>]>) {
      r = await call(c, "search_files", args);
      check(`invalid input is rejected: ${label}`, r.isError, r.text);
    }

    section("search_files: cannot leave the workspace");
    for (const p of ["../", "..", "../src", "../../", "folder/../../src", projectRoot, path.join(projectRoot, "src"), outsideDir, tmpBase, sentinel]) {
      for (const mode of ["content", "filename"] as const) {
        r = await call(c, "search_files", { query: "e", path: p, mode });
        check(`search ${mode} in ${JSON.stringify(path.isAbsolute(p) ? "<absolute path>" : p)} rejected`, isRejection(r), r.text);
      }
    }
    if (linksOk) {
      r = await call(c, "search_files", { query: "OUTSIDE-SECRET-MARKER", path: `${T}/link_out` });
      check("starting inside a link that points outside is rejected", isRejection(r) && !r.text.includes("OUTSIDE-SECRET-MARKER"), r.text);
      r = await call(c, "search_files", { query: "OUTSIDE-SECRET-MARKER" });
      check("searching the whole workspace never reaches the outside folder through a link", !r.isError && r.text.startsWith("No matches"), r.text);
      r = await call(c, "search_files", { query: "SENTINEL-OUTSIDE", path: `${T}/link_file` });
      check("a link to a file outside is rejected when named directly", isRejection(r) && !r.text.includes("SENTINEL"), r.text);
      r = await call(c, "search_files", { query: "SENTINEL-OUTSIDE" });
      check("...and is skipped during a folder search", !r.isError && r.text.startsWith("No matches"), r.text);
    }
    check("project source files are not reachable by search (a word that is only in src/ is not found)", (await call(c, "search_files", { query: "explainGitFailure" })).text.startsWith("No matches"));

    // =========================================================================
    section("git tools: no repository yet");
    await fs.rm(path.join(workspace, T), { recursive: true, force: true });
    await fs.rm(path.join(workspace, "_m4_many"), { recursive: true, force: true });
    await fs.rm(path.join(workspace, "_m4_core"), { recursive: true, force: true });
    linksToRemove.length = 1;
    for (const [tool, args] of [["git_status", {}], ["git_diff", {}], ["git_log", {}]] as Array<[string, Record<string, unknown>]>) {
      r = await call(c, tool, args);
      check(`${tool} says clearly that the folder is not a Git repository`, r.isError && r.text.includes("not a Git repository") && !r.text.includes(projectRoot), r.text);
    }
    git(tmpBase, "init", "-q"); // a repository in the PARENT folder must not be picked up
    r = await call(c, "git_status");
    check("a repository in a parent folder is NOT used", r.isError && r.text.includes("not a Git repository"), r.text);

    git(projectRoot, "init", "-q");
    r = await call(c, "git_log");
    check("git_log on a repository without commits says so", r.isError && r.text.includes("no commits yet"), r.text);
    git(projectRoot, "add", "workspace", "package.json");
    git(projectRoot, "commit", "-q", "-m", "initial test commit");

    section("git tools: status, diff, log");
    r = await call(c, "git_log");
    check("git_log shows short hash, date and message", !r.isError && /^[0-9a-f]{7,} \d{4}-\d\d-\d\d initial test commit$/m.test(r.text), r.text);
    check("git_log shows no author name or e-mail address", !r.text.includes("Test Author") && !r.text.includes("@") && !r.text.includes("example.invalid"), r.text);
    r = await call(c, "git_status");
    check("git_status reports a clean workspace", !r.isError && r.text.includes("No changes in workspace/ (clean)"), r.text);
    check("git_status shows the branch line", /^## \S+/m.test(r.text), r.text);
    await call(c, "write_file", { path: "_m4_git/new.txt", content: "brand new" });
    r = await call(c, "git_status");
    check("git_status lists a new file as untracked", r.text.includes("?? workspace/_m4_git/new.txt"), r.text);
    await call(c, "update_project_state", { section: "Current task", content: "GIT-DIFF-MARKER", agent: "test-agent-3" });
    r = await call(c, "git_status");
    check("git_status lists a modified tracked file", /^ M workspace\/PROJECT_STATE\.md$/m.test(r.text), r.text);
    r = await call(c, "git_diff");
    check("git_diff shows the change", !r.isError && r.text.includes("diff --git a/workspace/PROJECT_STATE.md") && /^\+GIT-DIFF-MARKER$/m.test(r.text), r.text);
    r = await call(c, "git_diff", { path: "PROJECT_STATE.md" });
    check("git_diff with a path shows that file", r.text.includes("+GIT-DIFF-MARKER"), r.text);
    r = await call(c, "git_diff", { path: "PLAN_LOG.md" });
    check("git_diff of an unchanged file says there are no changes", !r.isError && r.text.startsWith("No unstaged changes in workspace/PLAN_LOG.md"), r.text);
    r = await call(c, "git_diff", { stat_only: true });
    check("git_diff stat_only gives a short summary", !r.isError && r.text.includes("PROJECT_STATE.md") && r.text.includes("1 file changed") && !r.text.includes("GIT-DIFF-MARKER"), r.text);
    git(projectRoot, "add", "workspace/PROJECT_STATE.md");
    r = await call(c, "git_diff", { staged: true });
    check("git_diff staged=true shows staged changes", r.text.includes("+GIT-DIFF-MARKER"), r.text);
    r = await call(c, "git_diff");
    check("...and the unstaged diff is then empty", r.text.startsWith("No unstaged changes"), r.text);
    git(projectRoot, "reset", "-q");

    section("git tools: only the workspace is visible, and nothing is changed");
    await fs.appendFile(path.join(projectRoot, "package.json"), "\n"); // a tracked file OUTSIDE workspace/
    r = await call(c, "git_status");
    check("git_status does not show changes outside workspace/", !r.text.includes("package.json"), r.text);
    r = await call(c, "git_diff");
    check("git_diff does not show changes outside workspace/", !r.text.includes("package.json"), r.text);
    r = await call(c, "git_diff", { path: "../package.json" });
    check("git_diff with a path outside the workspace is rejected by the sandbox", isRejection(r), r.text);
    r = await call(c, "git_log", { path: "../package.json" });
    check("git_log with a path outside the workspace is rejected by the sandbox", isRejection(r), r.text);
    await put("_m4_git/big.txt", "1\n2\n3\n");
    git(projectRoot, "add", "workspace");
    git(projectRoot, "commit", "-q", "-m", "add big file");
    await call(c, "write_file", { path: "_m4_git/big.txt", content: Array.from({ length: 3000 }, (_, i) => `changed line number ${i}`).join("\n") });
    r = await call(c, "git_diff", { path: "_m4_git/big.txt" });
    check("a huge diff is shortened and says so", !r.isError && r.text.includes("[Output shortened") && r.text.split("\n").length < 320 && r.text.length < 31000, `${r.text.split("\n").length} lines, ${r.text.length} chars`);
    r = await call(c, "git_log", { limit: 1 });
    check("git_log limit=1 shows one commit", countLines(r.text, /^[0-9a-f]{7,} /) === 1 && r.text.includes("add big file"), r.text);
    r = await call(c, "git_log", { path: "_m4_git/big.txt" });
    check("git_log with a path only shows commits that touched it", r.text.includes("add big file") && !r.text.includes("initial test commit"), r.text);
    const indexBefore = await sha(path.join(projectRoot, ".git", "index"));
    const headBefore = git(projectRoot, "rev-parse", "HEAD");
    for (let i = 0; i < 3; i++) {
      await call(c, "git_status");
      await call(c, "git_diff");
      await call(c, "git_diff", { staged: true });
      await call(c, "git_log");
    }
    check("repeated git tool calls change nothing in the repository (index and HEAD identical)", (await sha(path.join(projectRoot, ".git", "index"))) === indexBefore && git(projectRoot, "rev-parse", "HEAD") === headBefore);

    section("git tools: they cannot be used to run commands");
    const injections = [
      `--output=${canary(1)}`,
      `x; touch ${canary(2)}`,
      `$(touch ${canary(3)})`,
      "`touch " + canary(4) + "`",
      `x && touch ${canary(5)}`,
      `x | touch ${canary(6)}`,
      "-p",
      "--help",
      "--version",
      ":(top)package.json",
      ":/package.json",
      "*",
    ];
    for (const p of injections) {
      const d = await call(c, "git_diff", { path: p });
      const l = await call(c, "git_log", { path: p });
      const looksLikeHelp = /usage: git|git version \d/i.test(d.text + l.text);
      check(`path ${JSON.stringify(p.length > 40 ? p.slice(0, 22) + "..." : p)} is only ever a file name (no option, no help text, no package.json content)`, !looksLikeHelp && !d.text.includes('"name"') && !l.text.includes('"name"'), d.text + " / " + l.text);
    }
    let created = 0;
    for (let i = 1; i <= 6; i++) if (await exists(canary(i))) created++;
    check("none of the injected commands or options created a file", created === 0, `${created} canary files exist`);
    for (const [tool, args] of [
      ["git_diff", { args: [`--output=${canary(7)}`] }],
      ["git_diff", { command: `touch ${canary(8)}` }],
      ["git_status", { command: `touch ${canary(9)}` }],
      ["git_status", { args: ["--help"] }],
      ["git_log", { format: "%H", command: "id" }],
      ["git_diff", { staged: "true" }],
      ["git_diff", { stat_only: 1 }],
      ["git_log", { limit: "5; touch x" }],
      ["git_log", { limit: 0 }],
      ["git_log", { limit: 51 }],
      ["git_log", { limit: 1.5 }],
    ] as Array<[string, Record<string, unknown>]>) {
      r = await call(c, tool, args);
      check(`${tool} rejects ${JSON.stringify(args).slice(0, 60)}`, r.isError, r.text);
    }
    check("...and no canary file was created by those either", !(await exists(canary(7))) && !(await exists(canary(8))) && !(await exists(canary(9))));
    check("git_diff of the sandbox-escaping path forms is rejected", isRejection(await call(c, "git_diff", { path: "../../etc" })) && isRejection(await call(c, "git_diff", { path: sentinel })));

    if (process.platform === "win32") {
      console.log("  SKIP  'git not installed' check (needs an empty PATH, not done on Windows)");
    } else {
      section("git tools: Git not installed");
      const emptyBin = path.join(tmpBase, "empty-bin");
      await fs.mkdir(emptyBin);
      noGitServer = startServer({ PATH: emptyBin });
      noGitClient = await newClient(await waitForPort(noGitServer));
      r = await call(noGitClient, "git_status");
      check("git_status explains that Git is not installed", r.isError && r.text.includes("Git is not installed"), r.text);
      r = await call(noGitClient, "read_project_state");
      check("the other tools keep working without Git", !r.isError && r.text.includes("# Project State"), r.text);
    }

    // =========================================================================
    section("The stdio server (M1/M2 entry point) has the same tools");
    stdioClient = new Client({ name: "m4-test-stdio", version: "1.0.0" });
    await stdioClient.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.join(projectRoot, "src", "server.ts")], cwd: projectRoot, stderr: "ignore" }));
    const stdioNames = (await stdioClient.listTools()).tools.map((t) => t.name).sort();
    check("stdio lists the same 17 tools", JSON.stringify(stdioNames) === JSON.stringify(EXPECTED_TOOLS), stdioNames.join(", "));
    r = await call(stdioClient, "read_project_state");
    check("read_project_state works over stdio", !r.isError && r.text.includes("# Project State"), r.text);
    r = await call(stdioClient, "git_status");
    check("git_status works over stdio", !r.isError && r.text.includes("## "), r.text);

    // =========================================================================
    section("Nothing outside the throwaway copy was touched");
    for (const f of realFiles) check(`REAL file ${path.relative(sourceRoot, f)} was never touched`, (await exists(f)) && (await sha(f)) === realBefore.get(f));
    check("the sentinel file is unchanged", (await fs.readFile(sentinel, "utf8")) === "SENTINEL-OUTSIDE");
    check("the outside folder is unchanged", (await fs.readdir(outsideDir)).join() === "secret.txt");

    section("Clean shutdown");
    await c.close().catch(() => {});
    client = undefined;
    if (process.platform === "win32") {
      console.log("  SKIP  signals are not delivered on Windows");
    } else {
      server.child.kill("SIGTERM");
      const code = await Promise.race([server.exited, sleep(8000).then(() => "timeout" as const)]);
      check("SIGTERM stops the HTTP server with exit code 0", code === 0, String(code));
    }
  } finally {
    await client?.close().catch(() => {});
    await noGitClient?.close().catch(() => {});
    await stdioClient?.close().catch(() => {});
    for (const s of [server, noGitServer]) {
      if (s && s.child.exitCode === null) s.child.kill();
    }
    await Promise.race([Promise.all([server.exited, noGitServer?.exited]), sleep(3000)]);
    for (const link of linksToRemove) await fs.unlink(link).catch(() => {});
    await fs.rm(tmpBase, { recursive: true, force: true });
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});