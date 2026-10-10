// M3 test script: starts the real HTTP MCP server (Streamable HTTP) and tests it
// both as an MCP client and with raw HTTP requests. Run it with:  npm run test:http
//
// SAFETY (same idea as the M2 test): the server is started from a throwaway COPY
// of the project in a temp folder, so even a sandbox bug could only damage the
// copy and a harmless sentinel file, never your real files.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let projectRoot = "";
let workspace = "";
const TEST_DIR = "_m3_test";

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

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  try {
    const r = await client.callTool({ name, arguments: args });
    const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
    return { isError: r.isError === true, text: content.map((c) => c.text ?? "").join("\n") };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) };
  }
}

const sha = async (file: string) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const readDisk = (rel: string) => fs.readFile(path.join(workspace, rel), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- running the server as a child process ---------------------------------

type RunningServer = {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
};

function startServer(port: string): RunningServer {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "server-http.ts")], {
    cwd: projectRoot,
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, output: () => out, exited };
}

// Waits for the "listening on http://HOST:PORT/mcp" line and returns both parts.
async function waitForAddress(server: RunningServer): Promise<{ host: string; port: number }> {
  for (let i = 0; i < 200; i++) {
    const m = server.output().match(/listening on http:\/\/([\d.]+):(\d+)\/mcp/);
    if (m) return { host: m[1] ?? "", port: Number(m[2]) };
    await sleep(100);
  }
  throw new Error("Server did not start. Output:\n" + server.output());
}

// ---- raw HTTP helpers (so we can send unusual requests) --------------------

function raw(
  port: number,
  method: string,
  urlPath: string,
  options: { headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

// Claims a huge body in the Content-Length header but sends none of it.
function oversizeByHeader(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...JSON_HEADERS, "Content-Length": "99999999" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      }
    );
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => reject(new Error("timeout")), 10000).unref();
  });
}

// Streams 6 MB with no Content-Length (chunked), more than the server's limit.
function oversizeByStreaming(port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...JSON_HEADERS, "Transfer-Encoding": "chunked" } },
      (res) => {
        res.resume();
        resolve(`status ${res.statusCode}`);
        req.destroy();
      }
    );
    req.on("error", () => resolve("connection closed"));
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    let sent = 0;
    const writeMore = (): void => {
      while (sent < 6 * 1024 * 1024) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    };
    writeMore();
    setTimeout(() => resolve("timeout"), 10000).unref();
  });
}

function externalIPv4(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

async function newClient(port: number): Promise<Client> {
  const client = new Client({ name: "m3-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

// ---- the tests --------------------------------------------------------------

async function main(): Promise<void> {
  // Throwaway copy of the project (the server runs from here).
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-m3-test-"));
  projectRoot = path.join(tmpBase, "project");
  workspace = path.join(projectRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.cp(path.join(sourceRoot, "src"), path.join(projectRoot, "src"), { recursive: true });
  await fs.copyFile(path.join(sourceRoot, "package.json"), path.join(projectRoot, "package.json"));
  await fs.copyFile(path.join(sourceRoot, "tsconfig.json"), path.join(projectRoot, "tsconfig.json"));
  const nodeModulesLink = path.join(projectRoot, "node_modules");
  await fs.symlink(path.join(sourceRoot, "node_modules"), nodeModulesLink, process.platform === "win32" ? "junction" : "dir");

  const sentinel = path.join(tmpBase, "outside-sentinel.txt");
  await fs.writeFile(sentinel, "SENTINEL");

  const realFiles = ["package.json", "tsconfig.json", path.join("src", "server.ts"), path.join("src", "tools.ts"), path.join("src", "server-http.ts")].map((f) =>
    path.join(sourceRoot, f)
  );
  const realBefore = new Map<string, string>();
  for (const f of realFiles) realBefore.set(f, await sha(f));

  const protectedFiles = ["package.json", "tsconfig.json", path.join("src", "server.ts"), path.join("src", "tools.ts")].map((f) => path.join(projectRoot, f));
  const before = new Map<string, string>();
  for (const f of protectedFiles) before.set(f, await sha(f));

  // PORT=0 asks the operating system for any free port.
  const server = startServer("0");
  let client: Client | undefined;
  let extraClients: Client[] = [];

  try {
    section("Startup");
    const { host, port } = await waitForAddress(server);
    check("HTTP server started and reported its address", port > 0, server.output());
    check("it listens on 127.0.0.1 (local machine only)", host === "127.0.0.1", `host was ${host}`);
    check("endpoint is /mcp", /\/mcp\n/.test(server.output()));

    // -------------------------------------------------------------------------
    section("Only /mcp exists (no other HTTP route exposes anything)");
    for (const p of ["/", "/package.json", "/src/server.ts", "/src/tools.ts", "/workspace/", "/workspace/notes.txt", "/mcp/", "/mcp/extra"]) {
      const r = await raw(port, "GET", p);
      check(`GET ${p} -> 404`, r.status === 404, `${r.status} ${r.text}`);
    }
    // Unnormalised paths that try to climb out of /mcp (sent exactly as written).
    for (const p of ["/mcp/../package.json", "/mcp/../../etc/passwd", "/%2e%2e/package.json", "/mcp%2f..%2fpackage.json"]) {
      const r = await raw(port, "GET", p);
      check(`GET ${p} -> 404 and no file contents`, r.status === 404 && !r.text.includes('"name"'), `${r.status} ${r.text.slice(0, 80)}`);
    }
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await raw(port, method, "/mcp");
      check(`${method} /mcp -> 405`, r.status === 405, `${r.status}`);
    }
    let r = await raw(port, "POST", "/mcp", { headers: JSON_HEADERS, body: "{not json" });
    check("POST /mcp with invalid JSON -> 400", r.status === 400 && r.text.includes("-32700"), `${r.status} ${r.text}`);
    r = await raw(port, "POST", "/mcp", { headers: JSON_HEADERS, body: "" });
    check("POST /mcp with an empty body -> 400", r.status === 400, `${r.status}`);
    r = await raw(port, "POST", "/mcp", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    check("POST /mcp without the required Accept header -> 406", r.status === 406, `${r.status}`);
    r = await raw(port, "POST", "/mcp", {
      headers: { "Content-Type": "text/plain", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    check("POST /mcp with the wrong Content-Type is refused", r.status === 415 || r.status === 400, `${r.status}`);
    check("a huge Content-Length is refused with 413", (await oversizeByHeader(port)) === 413);
    const streamed = await oversizeByStreaming(port);
    check("a 6 MB streamed body is refused (413 or connection closed)", streamed === "status 413" || streamed === "connection closed", streamed);

    // -------------------------------------------------------------------------
    section("MCP over Streamable HTTP: connect and list tools");
    client = await newClient(port);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    // (M4 added more tools on top of the five core ones; test/m4-test.ts checks the full list.)
    const coreTools = ["delete_file", "list_files", "read_file", "str_replace", "write_file"];
    check("the five core tools are available over HTTP", coreTools.every((t) => tools.includes(t)), tools.join(", "));
    check("the server still survived the oversized-body attempts", tools.length >= 5);

    // -------------------------------------------------------------------------
    section("Normal file operations over HTTP");
    let res = await call(client, "list_files", { path: "." });
    check("list_files('.') works", !res.isError && res.text.includes("workspace/."), res.text);
    res = await call(client, "write_file", { path: `${TEST_DIR}/notes.txt`, content: "Hello MCP" });
    check("write_file creates a file", !res.isError, res.text);
    check("the file exists on disk inside the workspace", (await readDisk(`${TEST_DIR}/notes.txt`)) === "Hello MCP");
    res = await call(client, "read_file", { path: `${TEST_DIR}/notes.txt` });
    check("read_file returns the contents", !res.isError && res.text === "Hello MCP", res.text);
    res = await call(client, "str_replace", { path: `${TEST_DIR}/notes.txt`, old: "MCP", new: "World" });
    check("str_replace works", !res.isError && (await readDisk(`${TEST_DIR}/notes.txt`)) === "Hello World", res.text);
    res = await call(client, "list_files", { path: TEST_DIR });
    check("list_files shows the new file", res.text.includes("[file] notes.txt"), res.text);
    res = await call(client, "delete_file", { path: `${TEST_DIR}/notes.txt` });
    check("delete_file removes it", !res.isError && !(await exists(path.join(workspace, TEST_DIR, "notes.txt"))), res.text);
    res = await call(client, "read_file", { path: `${TEST_DIR}/missing.txt` });
    check("a missing file gives a clear error without leaking absolute paths", res.isError && !res.text.includes(projectRoot), res.text);

    // -------------------------------------------------------------------------
    section("Two clients at the same time (stateless mode)");
    const a = await newClient(port);
    const b = await newClient(port);
    extraClients = [a, b];
    await Promise.all([
      call(a, "write_file", { path: `${TEST_DIR}/from-a.txt`, content: "A" }),
      call(b, "write_file", { path: `${TEST_DIR}/from-b.txt`, content: "B" }),
    ]);
    const [ra, rb] = await Promise.all([call(b, "read_file", { path: `${TEST_DIR}/from-a.txt` }), call(a, "read_file", { path: `${TEST_DIR}/from-b.txt` })]);
    check("each client can read what the other wrote", ra.text === "A" && rb.text === "B", `${ra.text} / ${rb.text}`);

    // -------------------------------------------------------------------------
    section("SECURITY over HTTP: path traversal and absolute paths (every tool, every path)");
    const attackPaths = [
      "../package.json",
      "../../package.json",
      "../src/server.ts",
      "../../src/server.ts",
      "folder/../../package.json",
      `${TEST_DIR}/../../package.json`,
      "a/b/../../../package.json",
      "..",
      "../src",
      path.join(projectRoot, "package.json"),
      path.join(projectRoot, "src", "server.ts"),
      sentinel,
    ];
    if (process.platform === "win32") attackPaths.push("..\\package.json", "folder\\..\\..\\package.json");
    const isRejection = (x: Result) => x.isError && (x.text.includes("outside the workspace") || x.text.includes("Absolute paths"));
    for (const p of attackPaths) {
      const results: Array<[string, Result]> = [
        ["list_files", await call(client, "list_files", { path: p })],
        ["read_file", await call(client, "read_file", { path: p })],
        ["write_file", await call(client, "write_file", { path: p, content: "HACKED" })],
        ["str_replace", await call(client, "str_replace", { path: p, old: "{", new: "HACKED" })],
        ["delete_file", await call(client, "delete_file", { path: p })],
      ];
      for (const [tool, out] of results) check(`${tool}(${JSON.stringify(p)}) rejected`, isRejection(out), out.text);
    }

    section("SECURITY over HTTP: a symlink pointing outside the workspace");
    let linked = true;
    try {
      await fs.mkdir(path.join(workspace, TEST_DIR), { recursive: true });
      await fs.symlink(path.join(projectRoot, "src"), path.join(workspace, TEST_DIR, "link_to_src"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false;
      console.log("  SKIP  could not create symlinks on this system");
    }
    if (linked) {
      res = await call(client, "read_file", { path: `${TEST_DIR}/link_to_src/server.ts` });
      check("read_file through the link rejected", isRejection(res), res.text);
      res = await call(client, "write_file", { path: `${TEST_DIR}/link_to_src/evil.txt`, content: "HACKED" });
      check("write_file through the link rejected", isRejection(res), res.text);
      check("...and nothing was created in src/", !(await exists(path.join(projectRoot, "src", "evil.txt"))));
    }

    section("SECURITY over HTTP: files outside workspace/ are untouched");
    for (const f of protectedFiles) {
      check(`${path.relative(projectRoot, f)} unchanged`, (await exists(f)) && (await sha(f)) === before.get(f));
    }
    check("the sentinel file outside the project is unchanged", (await fs.readFile(sentinel, "utf8")) === "SENTINEL");
    for (const f of realFiles) {
      check(`REAL project file ${path.relative(sourceRoot, f)} was never touched`, (await exists(f)) && (await sha(f)) === realBefore.get(f));
    }

    // -------------------------------------------------------------------------
    section("Network exposure: loopback only");
    const lanIp = externalIPv4();
    if (!lanIp) {
      console.log("  SKIP  this machine has no non-loopback IPv4 address to test with");
    } else {
      const reachable = await new Promise<boolean>((resolve) => {
        const req = http.get({ host: lanIp, port, path: "/mcp", timeout: 3000 }, (res2) => {
          res2.resume();
          resolve(true);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      });
      check("the server is NOT reachable through this machine's network address", !reachable);
    }

    // -------------------------------------------------------------------------
    section("Starting a second server on the same port");
    const second = startServer(String(port));
    const secondCode = await second.exited;
    check("it exits with a failure code", secondCode === 1, `code ${secondCode}`);
    check("and explains that the port is in use", second.output().includes("already in use"), second.output());

    // -------------------------------------------------------------------------
    section("Clean shutdown");
    await client.close().catch(() => {});
    for (const c of extraClients) await c.close().catch(() => {});
    client = undefined;
    extraClients = [];
    if (process.platform === "win32") {
      console.log("  SKIP  signals are not delivered on Windows; PM2 uses a shutdown message there");
    } else {
      server.child.kill("SIGTERM");
      const code = await Promise.race([server.exited, sleep(8000).then(() => "timeout" as const)]);
      check("SIGTERM stops the server with exit code 0", code === 0, String(code));
      check("it logs that it closed cleanly", server.output().includes("Server closed."), server.output());
    }
  } finally {
    await client?.close().catch(() => {});
    for (const c of extraClients) await c.close().catch(() => {});
    if (server.child.exitCode === null) server.child.kill();
    await Promise.race([server.exited, sleep(3000)]);
    for (const link of [path.join(workspace, TEST_DIR, "link_to_src"), nodeModulesLink]) {
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