// M5 OAuth test script: starts the real HTTP MCP server and tests the OAuth sign-in
// (discovery, registration, owner approval, PKCE, tokens, refresh, revoke, expiry)
// and that /mcp is protected. Run it with:  npm run test:oauth
//
// SAFETY (same idea as the M2/M3 tests): the server is started from a throwaway COPY of the
// project in a temp folder, so even a bug could only damage the copy, never your real files.
// Every password and token in this test is made up on the spot and exists only while the test runs.
//
// This test does NOT prove that Claude.ai can connect. That needs a real connection (a later step).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let projectRoot = "";
let workspace = "";

// Throwaway secrets, made up for this run only.
const rand = (n = 16) => crypto.randomBytes(n).toString("hex");
const STATIC_TOKEN = "test-static-" + rand();
const OWNER_PASSWORD = "test-owner-" + rand();
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_COM_CALLBACK = "https://claude.com/api/mcp/auth_callback";
const EXTRA_CALLBACK = "http://localhost:33418/callback";

// Everything secret that was ever created or sent, so we can prove none of it reaches the log or the disk.
const secrets: string[] = [STATIC_TOKEN, OWNER_PASSWORD];
const remember = (...values: Array<string | undefined>) => {
  for (const v of values) if (v) secrets.push(v);
};

// ---- tiny test helpers ------------------------------------------------------

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? "  -> " + detail.slice(0, 300) : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = async (file: string) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const parseJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const b64url = (b: Buffer) => b.toString("base64url");

// ---- running the server as a child process ---------------------------------

type RunningServer = { child: ChildProcess; output: () => string; exited: Promise<number | null>; port: number };
const started: RunningServer[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// "extra" can change or (with undefined) remove environment variables.
function spawnServer(port: number, extra: Record<string, string | undefined>): RunningServer {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), MCP_AUTH_TOKEN: STATIC_TOKEN, ...extra };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "server-http.ts")], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const server = { child, output: () => out, exited, port };
  started.push(server);
  return server;
}

async function waitListening(server: RunningServer): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (/listening on http:\/\/127\.0\.0\.1:\d+\/mcp/.test(server.output())) return;
    if (server.child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error("Server did not start. Output:\n" + server.output());
}

// A server with OAuth switched on (public address = its own local address, which the server allows for testing).
async function startOAuthServer(extra: Record<string, string | undefined> = {}): Promise<RunningServer> {
  const port = await freePort();
  const server = spawnServer(port, { MCP_PUBLIC_URL: `http://127.0.0.1:${port}`, MCP_OWNER_PASSWORD: OWNER_PASSWORD, ...extra });
  await waitListening(server);
  return server;
}

// ---- raw HTTP helper (so we can send unusual requests and see redirects) ----

type Reply = { status: number; text: string; headers: http.IncomingHttpHeaders; json: any };
function raw(port: number, method: string, urlPath: string, options: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers, json: parseJson(text) });
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
const form = (fields: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined) as Array<[string, string]>).toString();

// ---- OAuth helpers ----------------------------------------------------------

const publicUrl = (s: RunningServer) => `http://127.0.0.1:${s.port}`;
const resourceOf = (s: RunningServer) => `${publicUrl(s)}/mcp`;

function mcpCall(s: RunningServer, token: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, extra: Record<string, string> = {}) {
  return raw(s.port, "POST", "/mcp", {
    headers: { ...JSON_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
}
const toolCall = (name: string, args: Record<string, unknown>, id = 2) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function registerClient(s: RunningServer, redirect: string | string[] | null, name = "Test Claude"): Promise<Reply> {
  const body: Record<string, unknown> = { client_name: name, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  if (redirect !== null) body.redirect_uris = Array.isArray(redirect) ? redirect : [redirect];
  return raw(s.port, "POST", "/register", { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function newClientId(s: RunningServer, redirect = CLAUDE_CALLBACK, name = "Test Claude"): Promise<string> {
  const r = await registerClient(s, redirect, name);
  if (r.status !== 201 || !r.json?.client_id) throw new Error(`registration failed: ${r.status} ${r.text}`);
  return r.json.client_id as string;
}

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

function authorize(s: RunningServer, p: Record<string, string | undefined>): Promise<Reply> {
  return raw(s.port, "GET", "/authorize?" + form({ response_type: "code", code_challenge_method: "S256", scope: "workspace", ...p }));
}
const requestIdOf = (html: string) => /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
const consent = (s: RunningServer, fields: Record<string, string | undefined>) => raw(s.port, "POST", "/consent", { headers: FORM_HEADERS, body: form(fields) });
const tokenRequest = (s: RunningServer, fields: Record<string, string | undefined>) => raw(s.port, "POST", "/token", { headers: FORM_HEADERS, body: form(fields) });

// authorize page -> owner approves -> the code that Claude would receive at its callback address
async function getCode(s: RunningServer, clientId: string, o: { redirectUri?: string; password?: string; resource?: string } = {}) {
  const { verifier, challenge } = pkce();
  const state = "state-" + rand(6);
  const redirectUri = o.redirectUri ?? CLAUDE_CALLBACK;
  const page = await authorize(s, { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, state, resource: o.resource ?? resourceOf(s) });
  const requestId = requestIdOf(page.text);
  const c = await consent(s, { request_id: requestId, password: o.password ?? OWNER_PASSWORD, decision: "approve" });
  const location = new URL(String(c.headers.location ?? "http://none.invalid/"));
  const code = location.searchParams.get("code") ?? "";
  remember(code, verifier, requestId);
  return { verifier, challenge, state, redirectUri, code, location, page, consentReply: c };
}

type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope?: string };
async function getTokens(s: RunningServer, clientId: string): Promise<Tokens> {
  const g = await getCode(s, clientId);
  const r = await tokenRequest(s, { grant_type: "authorization_code", client_id: clientId, code: g.code, code_verifier: g.verifier, redirect_uri: g.redirectUri, resource: resourceOf(s) });
  if (r.status !== 200 || !r.json?.access_token) throw new Error(`token exchange failed: ${r.status} ${r.text}`);
  remember(r.json.access_token, r.json.refresh_token);
  return r.json as Tokens;
}

async function sdkClient(s: RunningServer, token: string): Promise<Client> {
  const client = new Client({ name: "m5-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl(s)}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function readAllFiles(dir: string, skip: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await readAllFiles(full, skip)));
    else if (entry.isFile()) found.push(await fs.readFile(full, "utf8").catch(() => ""));
  }
  return found;
}

// ---- the tests --------------------------------------------------------------

async function main(): Promise<void> {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-m5-test-"));
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
  const realFiles = ["package.json", "tsconfig.json", path.join("src", "server-http.ts"), path.join("src", "oauth.ts"), path.join("src", "tools.ts")].map((f) => path.join(sourceRoot, f));
  const realBefore = new Map<string, string>();
  for (const f of realFiles) realBefore.set(f, await sha(f));
  const copiedProjectJson = path.join(projectRoot, "package.json");
  const copiedBefore = await sha(copiedProjectJson);

  const clients: Client[] = [];
  let A: RunningServer | undefined;

  try {
    // -----------------------------------------------------------------------
    section("Start-up refuses missing or unsafe OAuth settings");
    const badSettings: Array<[string, Record<string, string | undefined>, string]> = [
      ["only the public address is set", { MCP_PUBLIC_URL: "https://demo.example.dev" }, "MCP_OWNER_PASSWORD"],
      ["only the owner password is set", { MCP_OWNER_PASSWORD: OWNER_PASSWORD }, "MCP_PUBLIC_URL"],
      ["the public address is plain http on a real host", { MCP_PUBLIC_URL: "http://demo.example.dev", MCP_OWNER_PASSWORD: OWNER_PASSWORD }, "https"],
      ["the public address is not an address", { MCP_PUBLIC_URL: "not a url", MCP_OWNER_PASSWORD: OWNER_PASSWORD }, "MCP_PUBLIC_URL"],
      ["the public address has a path", { MCP_PUBLIC_URL: "https://demo.example.dev/mcp", MCP_OWNER_PASSWORD: OWNER_PASSWORD }, "no path"],
      ["the owner password is too short", { MCP_PUBLIC_URL: "https://demo.example.dev", MCP_OWNER_PASSWORD: "short" }, "too short"],
      ["the owner password equals the fixed token", { MCP_PUBLIC_URL: "https://demo.example.dev", MCP_OWNER_PASSWORD: STATIC_TOKEN }, "different"],
      ["the token lifetime is not a number", { MCP_PUBLIC_URL: "https://demo.example.dev", MCP_OWNER_PASSWORD: OWNER_PASSWORD, MCP_ACCESS_TOKEN_TTL_SECONDS: "abc" }, "MCP_ACCESS_TOKEN_TTL_SECONDS"],
      ["the token lifetime is zero", { MCP_PUBLIC_URL: "https://demo.example.dev", MCP_OWNER_PASSWORD: OWNER_PASSWORD, MCP_ACCESS_TOKEN_TTL_SECONDS: "0" }, "MCP_ACCESS_TOKEN_TTL_SECONDS"],
      ["an extra callback address is plain http on a real host", { MCP_PUBLIC_URL: "https://demo.example.dev", MCP_OWNER_PASSWORD: OWNER_PASSWORD, MCP_EXTRA_REDIRECT_URIS: "http://evil.example/cb" }, "MCP_EXTRA_REDIRECT_URIS"],
    ];
    for (const [label, env, word] of badSettings) {
      const s = spawnServer(await freePort(), env);
      const code = await s.exited;
      const out = s.output();
      check(`${label}: exits with code 1`, code === 1, `exit ${code}`);
      check(`${label}: the message names the problem`, out.includes(word), out);
      check(`${label}: it never started listening`, !out.includes("listening on"));
      check(`${label}: no password or token in the message`, !out.includes(OWNER_PASSWORD) && !out.includes(STATIC_TOKEN));
    }
    {
      const s = spawnServer(await freePort(), { MCP_PUBLIC_URL: undefined, MCP_OWNER_PASSWORD: undefined, MCP_AUTH_TOKEN: undefined });
      const code = await s.exited;
      check("OAuth settings alone are not enough: without MCP_AUTH_TOKEN it still refuses to start", code === 1 && s.output().includes("MCP_AUTH_TOKEN") && !s.output().includes("listening on"), s.output());
    }

    // -----------------------------------------------------------------------
    section("OAuth NOT configured: the fixed token still works, and no OAuth route exists");
    {
      const off = spawnServer(await freePort(), { MCP_PUBLIC_URL: undefined, MCP_OWNER_PASSWORD: undefined });
      await waitListening(off);
      check("the start-up log says fixed token only", off.output().includes("fixed token only"), off.output());
      for (const [method, p] of [
        ["GET", "/.well-known/oauth-protected-resource/mcp"],
        ["GET", "/.well-known/oauth-protected-resource"],
        ["GET", "/.well-known/oauth-authorization-server"],
        ["POST", "/register"],
        ["GET", "/authorize"],
        ["POST", "/consent"],
        ["POST", "/token"],
        ["POST", "/revoke"],
      ] as const) {
        const r = await raw(off.port, method, p);
        check(`${method} ${p} -> 404`, r.status === 404, `${r.status} ${r.text}`);
      }
      const noToken = await mcpCall(off, null);
      const header = String(noToken.headers["www-authenticate"] ?? "");
      check("no token -> 401", noToken.status === 401);
      check("the 401 does NOT point to any OAuth information", header.startsWith("Bearer") && !header.includes("resource_metadata"), header);
      const withStatic = await mcpCall(off, STATIC_TOKEN);
      check("the fixed token -> 200", withStatic.status === 200, `${withStatic.status}`);
      off.child.kill();
      await off.exited;
    }

    // -----------------------------------------------------------------------
    A = await startOAuthServer({ MCP_EXTRA_REDIRECT_URIS: EXTRA_CALLBACK });
    const base = publicUrl(A);
    section("OAuth configured: start-up and discovery");
    check("the start-up log says fixed token AND OAuth", A.output().includes("fixed token AND OAuth"), A.output());
    check("it still listens on 127.0.0.1 only", /listening on http:\/\/127\.0\.0\.1:/.test(A.output()));

    const prm = await raw(A.port, "GET", "/.well-known/oauth-protected-resource/mcp");
    check("protected-resource metadata is served (200, JSON)", prm.status === 200 && prm.json !== null, `${prm.status} ${prm.text}`);
    check("it names this server's /mcp address as the resource", prm.json?.resource === resourceOf(A), JSON.stringify(prm.json));
    check("it names this server as the authorization server", Array.isArray(prm.json?.authorization_servers) && prm.json.authorization_servers.some((u: string) => u.replace(/\/$/, "") === base), JSON.stringify(prm.json));
    check("it lists the workspace scope", Array.isArray(prm.json?.scopes_supported) && prm.json.scopes_supported.includes("workspace"));

    const asm = await raw(A.port, "GET", "/.well-known/oauth-authorization-server");
    check("authorization-server metadata is served (200, JSON)", asm.status === 200 && asm.json !== null, `${asm.status} ${asm.text}`);
    check("the issuer is this server", String(asm.json?.issuer ?? "").replace(/\/$/, "") === base, JSON.stringify(asm.json));
    check("it advertises the authorize, token, register and revoke endpoints on this server",
      ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"].every((k) => typeof asm.json?.[k] === "string" && asm.json[k].startsWith(base)), JSON.stringify(asm.json));
    check("PKCE is S256 only", JSON.stringify(asm.json?.code_challenge_methods_supported) === JSON.stringify(["S256"]), JSON.stringify(asm.json?.code_challenge_methods_supported));
    check("only the authorization-code and refresh-token grants are offered", JSON.stringify([...(asm.json?.grant_types_supported ?? [])].sort()) === JSON.stringify(["authorization_code", "refresh_token"]), JSON.stringify(asm.json?.grant_types_supported));
    check("clients do not need a secret (public clients, 'none')", Array.isArray(asm.json?.token_endpoint_auth_methods_supported) && asm.json.token_endpoint_auth_methods_supported.includes("none"));

    // -----------------------------------------------------------------------
    section("/mcp is protected, with OAuth on");
    let r = await mcpCall(A, null);
    let header = String(r.headers["www-authenticate"] ?? "");
    check("no credential -> 401", r.status === 401, `${r.status}`);
    check("the 401 points to the protected-resource metadata", header.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`), header);
    check("the 401 starts with Bearer and has no error code when nothing was sent", header.startsWith("Bearer") && !header.includes("error="), header);
    check("the 401 body does not list any tools", !r.text.includes("list_files") && !r.text.includes('"tools"'));
    r = await mcpCall(A, "this-is-not-a-real-token-" + rand(8));
    header = String(r.headers["www-authenticate"] ?? "");
    check("a made-up token -> 401 with error=invalid_token and the metadata pointer", r.status === 401 && header.includes('error="invalid_token"') && header.includes("resource_metadata"), `${r.status} ${header}`);
    r = await raw(A.port, "POST", "/mcp", { headers: JSON_HEADERS, body: "{not json" });
    check("invalid JSON without a credential -> 401 (the body is not even read)", r.status === 401, `${r.status}`);
    r = await raw(A.port, "POST", "/mcp", { headers: { ...JSON_HEADERS, "Content-Length": "99999999" } });
    check("a huge Content-Length without a credential -> 401", r.status === 401, `${r.status}`);
    r = await mcpCall(A, null, toolCall("write_file", { path: "_m5_test/unauth.txt", content: "should not exist" }));
    check("an unauthenticated write_file -> 401", r.status === 401);
    check("...and no file was created", !(await exists(path.join(workspace, "_m5_test", "unauth.txt"))));
    r = await raw(A.port, "POST", "/mcp?access_token=" + STATIC_TOKEN, { headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    check("the fixed token in the URL is NOT accepted", r.status === 401, `${r.status}`);
    r = await mcpCall(A, null, undefined, { "X-Api-Key": STATIC_TOKEN, Cookie: `token=${STATIC_TOKEN}` });
    check("the fixed token in another header or a cookie is NOT accepted", r.status === 401, `${r.status}`);
    r = await mcpCall(A, STATIC_TOKEN);
    check("the fixed token still works with OAuth on", r.status === 200 && Array.isArray(r.json?.result?.tools), `${r.status} ${r.text.slice(0, 100)}`);
    r = await raw(A.port, "GET", "/mcp");
    check("GET /mcp -> 405", r.status === 405);
    for (const p of ["/", "/package.json", "/src/oauth.ts", "/workspace/", "/authorize/", "/token/", "/.well-known/", "/.well-known/oauth-evil"]) {
      r = await raw(A.port, "GET", p);
      check(`GET ${p} -> 404 and no file contents`, r.status === 404 && !r.text.includes('"name"'), `${r.status} ${r.text.slice(0, 80)}`);
    }
    for (const p of ["/token", "/register", "/revoke", "/consent"]) {
      r = await raw(A.port, "GET", p);
      check(`GET ${p} is not served (405 or 404)`, r.status === 405 || r.status === 404, `${r.status}`);
    }

    // -----------------------------------------------------------------------
    section("Client registration only accepts Claude's callback addresses");
    for (const [label, redirect] of [
      ["an unknown website", "https://evil.example/callback"],
      ["claude.ai with a different path", "https://claude.ai/evil"],
      ["a look-alike host", "https://claude.ai.evil.example/api/mcp/auth_callback"],
      ["plain http", "http://claude.ai/api/mcp/auth_callback"],
      ["a local address that was not allowed", "http://localhost:1234/callback"],
    ] as const) {
      const reg = await registerClient(A, redirect);
      check(`registering ${label} is refused`, reg.status === 400 && reg.json?.error === "invalid_client_metadata" && !reg.json?.client_id, `${reg.status} ${reg.text}`);
    }
    r = await registerClient(A, [CLAUDE_CALLBACK, "https://evil.example/callback"]);
    check("one good address plus one bad address is refused", r.status === 400 && !r.json?.client_id, `${r.status} ${r.text}`);
    r = await registerClient(A, null);
    check("registering with no redirect address is refused", r.status === 400 && !r.json?.client_id, `${r.status} ${r.text}`);
    r = await registerClient(A, CLAUDE_CALLBACK);
    check("Claude's claude.ai callback is accepted (201 with a client_id)", r.status === 201 && typeof r.json?.client_id === "string", `${r.status} ${r.text}`);
    check("no client secret is issued to a public client", r.json?.client_secret === undefined);
    const clientId = r.json.client_id as string;
    r = await registerClient(A, CLAUDE_COM_CALLBACK);
    check("Claude's claude.com callback is accepted", r.status === 201, `${r.status} ${r.text}`);
    r = await registerClient(A, EXTRA_CALLBACK);
    check("an address the owner allowed with MCP_EXTRA_REDIRECT_URIS is accepted", r.status === 201, `${r.status} ${r.text}`);

    // -----------------------------------------------------------------------
    section("The owner-approval page");
    const xssName = "<script>alert('x')</script>";
    const xssClient = await newClientId(A, CLAUDE_CALLBACK, xssName);
    const p1 = pkce();
    let page = await authorize(A, { client_id: xssClient, redirect_uri: CLAUDE_CALLBACK, code_challenge: p1.challenge, state: "s1", resource: resourceOf(A) });
    check("/authorize shows the approval page (200, HTML, a password field)", page.status === 200 && page.text.includes('type="password"') && requestIdOf(page.text) !== "", `${page.status} ${page.text.slice(0, 100)}`);
    check("an app name containing HTML is shown as plain text, never as a tag", !page.text.includes("<script>alert") && page.text.includes("&lt;script&gt;"), page.text.slice(0, 400));
    check("the page can not be shown inside another website", String(page.headers["x-frame-options"] ?? "").toUpperCase() === "DENY" && String(page.headers["content-security-policy"] ?? "").includes("frame-ancestors 'none'"));
    check("the page is not cached and sends no referrer", String(page.headers["cache-control"] ?? "").includes("no-store") && page.headers["referrer-policy"] === "no-referrer");
    check("the page does not contain any code or token", !/code=|access_token|refresh_token/.test(page.text));
    check("the page warns that files can be read, written and deleted", /read, write and delete files/.test(page.text));

    const noForm = (rep: Reply) => !rep.text.includes('type="password"') && !rep.text.includes("request_id");
    const noCode = (rep: Reply) => !String(rep.headers.location ?? "").includes("code=");
    page = await authorize(A, { client_id: "no-such-client", redirect_uri: CLAUDE_CALLBACK, code_challenge: p1.challenge, resource: resourceOf(A) });
    check("an unknown client_id gets no approval page", page.status >= 400 && noForm(page) && noCode(page), `${page.status}`);
    page = await authorize(A, { client_id: clientId, redirect_uri: CLAUDE_COM_CALLBACK, code_challenge: p1.challenge, resource: resourceOf(A) });
    check("a redirect address that this client did not register gets no approval page", page.status >= 400 && noForm(page) && noCode(page), `${page.status} ${page.text.slice(0, 100)}`);
    page = await authorize(A, { client_id: clientId, redirect_uri: "https://evil.example/callback", code_challenge: p1.challenge, resource: resourceOf(A) });
    check("a foreign redirect address gets no approval page and no redirect to it", page.status >= 400 && noForm(page) && !String(page.headers.location ?? "").includes("evil.example"), `${page.status} ${page.headers.location}`);
    page = await authorize(A, { client_id: clientId, redirect_uri: CLAUDE_CALLBACK, resource: resourceOf(A) });
    check("a request with no PKCE challenge gets no approval page", noForm(page) && noCode(page), `${page.status} ${page.text.slice(0, 100)}`);
    page = await authorize(A, { client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: p1.challenge, code_challenge_method: "plain", resource: resourceOf(A) });
    check("PKCE method 'plain' is refused", noForm(page) && noCode(page), `${page.status} ${page.text.slice(0, 100)}`);
    page = await authorize(A, { client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: p1.challenge, resource: "https://other.example/mcp" });
    check("a request for a different resource gets no approval page", noForm(page) && noCode(page), `${page.status} ${page.text.slice(0, 100)}`);
    page = await authorize(A, { client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: p1.challenge, resource: resourceOf(A), response_type: "token" });
    check("response_type=token (implicit flow) is refused", noForm(page) && noCode(page), `${page.status} ${page.text.slice(0, 100)}`);

    // -----------------------------------------------------------------------
    section("Owner approval: password, deny, and single-use requests");
    const pw = pkce();
    page = await authorize(A, { client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_challenge: pw.challenge, state: "s2", resource: resourceOf(A) });
    const rid = requestIdOf(page.text);
    for (const wrong of ["wrong-password-" + rand(4), "", OWNER_PASSWORD + "x", OWNER_PASSWORD.slice(0, -1)]) {
      remember(wrong);
      const c = await consent(A, { request_id: rid, password: wrong, decision: "approve" });
      check(`a wrong owner password (${wrong === "" ? "empty" : wrong === OWNER_PASSWORD + "x" ? "right + 1 extra char" : wrong === OWNER_PASSWORD.slice(0, -1) ? "right - 1 char" : "random"}) -> 401, no redirect, no code`,
        c.status === 401 && !c.headers.location && !c.text.includes("code="), `${c.status} ${c.headers.location}`);
      check("...and the page is shown again with an error", c.text.includes("Wrong password") && requestIdOf(c.text) === rid);
    }
    let c = await consent(A, { request_id: "does-not-exist", password: OWNER_PASSWORD, decision: "approve" });
    check("an unknown approval request id -> 400, no redirect", c.status === 400 && !c.headers.location, `${c.status}`);
    c = await consent(A, { password: OWNER_PASSWORD, decision: "approve" });
    check("a missing approval request id -> 400", c.status === 400, `${c.status}`);
    c = await consent(A, { request_id: rid, password: OWNER_PASSWORD, decision: "maybe" });
    check("an unknown decision -> 400, nothing approved", c.status === 400 && !c.headers.location, `${c.status}`);
    c = await raw(A.port, "POST", "/consent", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: rid, password: OWNER_PASSWORD, decision: "approve" }) });
    check("approval sent as JSON instead of a form is not accepted", c.status >= 400 && !c.headers.location, `${c.status} ${c.headers.location}`);
    c = await raw(A.port, "POST", "/consent", { headers: FORM_HEADERS, body: "request_id=" + "a".repeat(10000) });
    check("an oversized approval body is refused", c.status === 413 || c.status === 400, `${c.status}`);
    // Deny
    c = await consent(A, { request_id: rid, decision: "deny" });
    let loc = new URL(String(c.headers.location ?? "http://none.invalid/"));
    check("Deny -> 302 back to Claude with error=access_denied and the same state", c.status === 302 && loc.origin + loc.pathname === CLAUDE_CALLBACK && loc.searchParams.get("error") === "access_denied" && loc.searchParams.get("state") === "s2" && !loc.searchParams.has("code"), String(c.headers.location));
    c = await consent(A, { request_id: rid, password: OWNER_PASSWORD, decision: "approve" });
    check("a denied request cannot be approved afterwards (the request is used up)", c.status === 400 && !c.headers.location, `${c.status}`);
    // Approve
    const g = await getCode(A, clientId);
    check("the right password -> 302 back to Claude's callback", g.consentReply.status === 302 && g.location.origin + g.location.pathname === CLAUDE_CALLBACK, String(g.consentReply.headers.location));
    check("the redirect carries a code and echoes the state", g.code.length >= 20 && g.location.searchParams.get("state") === g.state);
    check("the redirect is not cached and sends no referrer", String(g.consentReply.headers["cache-control"] ?? "").includes("no-store") && g.consentReply.headers["referrer-policy"] === "no-referrer");
    c = await consent(A, { request_id: g.page.text ? requestIdOf(g.page.text) : "", password: OWNER_PASSWORD, decision: "approve" });
    check("an approved request cannot be approved a second time", c.status === 400 && !c.headers.location, `${c.status}`);

    // -----------------------------------------------------------------------
    section("Exchanging the code for tokens (PKCE, redirect address, resource)");
    if (!A) throw new Error("OAuth test server was not started");
    const fresh = await getCode(A, clientId);
    const body = (over: Record<string, string | undefined> = {}) => ({ grant_type: "authorization_code", client_id: clientId, code: fresh.code, code_verifier: fresh.verifier, redirect_uri: fresh.redirectUri, resource: resourceOf(A!), ...over });
    r = await tokenRequest(A, body({ code_verifier: pkce().verifier }));
    check("a wrong PKCE verifier -> 400 invalid_grant", r.status === 400 && r.json?.error === "invalid_grant" && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ code_verifier: undefined }));
    check("a missing PKCE verifier -> 400", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ code_verifier: "short" }));
    check("a too-short PKCE verifier -> 400", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ code: "not-a-real-code-" + rand(8) }));
    check("a made-up code -> 400 invalid_grant", r.status === 400 && r.json?.error === "invalid_grant", `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ redirect_uri: CLAUDE_COM_CALLBACK }));
    check("a different redirect_uri -> 400, no tokens", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ resource: "https://other.example/mcp" }));
    check("a different resource -> 400 invalid_target, no tokens", r.status === 400 && r.json?.error === "invalid_target" && !r.json?.access_token, `${r.status} ${r.text}`);
    const otherClient = await newClientId(A, CLAUDE_COM_CALLBACK, "Other app");
    r = await tokenRequest(A, body({ client_id: otherClient, redirect_uri: CLAUDE_COM_CALLBACK }));
    check("another client cannot redeem this client's code", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ grant_type: "password", username: "owner", password: OWNER_PASSWORD }));
    check("the 'password' grant type is not supported", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ grant_type: "client_credentials" }));
    check("the 'client_credentials' grant type is not supported", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, body({ code: STATIC_TOKEN }));
    check("the fixed MCP_AUTH_TOKEN is not a valid code", r.status === 400 && !r.json?.access_token, `${r.status}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: STATIC_TOKEN });
    check("the fixed MCP_AUTH_TOKEN is not a valid refresh token", r.status === 400 && !r.json?.access_token, `${r.status}`);
    r = await tokenRequest(A, body());
    const tokens: Tokens = r.json;
    remember(tokens?.access_token, tokens?.refresh_token);
    check("the right code + verifier + redirect + resource -> 200 with tokens", r.status === 200 && !!tokens?.access_token && !!tokens?.refresh_token, `${r.status} ${r.text}`);
    check("the token type is Bearer and it lasts 3600 seconds by default", tokens?.token_type?.toLowerCase() === "bearer" && tokens?.expires_in === 3600, JSON.stringify({ t: tokens?.token_type, e: tokens?.expires_in }));
    check("the granted scope is 'workspace'", tokens?.scope === "workspace", String(tokens?.scope));
    check("the token response must not be cached", String(r.headers["cache-control"] ?? "").includes("no-store"), String(r.headers["cache-control"]));
    check("the tokens are long random values, not the fixed token or the owner password", tokens.access_token.length >= 40 && tokens.refresh_token.length >= 40 && tokens.access_token !== STATIC_TOKEN && tokens.access_token !== tokens.refresh_token);
    // Code reuse
    const early = await mcpCall(A, tokens.access_token);
    check("the new access token works on /mcp", early.status === 200, `${early.status}`);
    r = await tokenRequest(A, body());
    check("using the same code a second time -> 400", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await mcpCall(A, tokens.access_token);
    check("...and the tokens that were issued from that code are revoked", r.status === 401, `${r.status}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });
    check("...including the refresh token", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);

    // -----------------------------------------------------------------------
    section("Using an OAuth access token on /mcp");
    const t = await getTokens(A, clientId);
    r = await mcpCall(A, t.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
    check("initialize with an OAuth access token -> 200", r.status === 200 && !!r.json?.result, `${r.status} ${r.text.slice(0, 120)}`);
    const client = await sdkClient(A, t.access_token);
    clients.push(client);
    const listed = (await client.listTools()).tools.map((x) => x.name);
    check("the MCP client lists the five core tools", ["list_files", "read_file", "write_file", "str_replace", "delete_file"].every((n) => listed.includes(n)), listed.join(","));
    const callTool = async (name: string, args: Record<string, unknown>) => {
      try {
        const res = await client.callTool({ name, arguments: args });
        return { isError: res.isError === true, text: ((res.content ?? []) as Array<{ text?: string }>).map((x) => x.text ?? "").join("\n") };
      } catch (err) {
        return { isError: true, text: err instanceof Error ? err.message : String(err) };
      }
    };
    let tc = await callTool("write_file", { path: "_m5_test/hello.txt", content: "hello from oauth" });
    check("write_file works with an OAuth token", !tc.isError, tc.text);
    check("...and the file is on disk inside the workspace", (await fs.readFile(path.join(workspace, "_m5_test", "hello.txt"), "utf8").catch(() => "")) === "hello from oauth");
    tc = await callTool("read_file", { path: "_m5_test/hello.txt" });
    check("read_file returns it", !tc.isError && tc.text.includes("hello from oauth"), tc.text);
    tc = await callTool("str_replace", { path: "_m5_test/hello.txt", old: "oauth", new: "OAuth" });
    check("str_replace works", !tc.isError && (await fs.readFile(path.join(workspace, "_m5_test", "hello.txt"), "utf8")) === "hello from OAuth", tc.text);
    for (const [tool, extraArgs] of [["list_files", {}], ["read_file", {}], ["write_file", { content: "x" }], ["str_replace", { old: "a", new: "b" }], ["delete_file", {}]] as const) {
      // A backslash only separates folders on Windows (on Linux/macOS it is just a character in a file name).
      const badPaths = ["../package.json", "folder/../../package.json", path.join(projectRoot, "package.json"), path.join(tmpBase, "outside-sentinel.txt")];
      if (process.platform === "win32") badPaths.push("..\\package.json");
      for (const bad of badPaths) {
        const res = await callTool(tool, { path: bad, ...extraArgs });
        check(`the sandbox still rejects ${tool}(${bad === path.join(projectRoot, "package.json") || bad === path.join(tmpBase, "outside-sentinel.txt") ? "<absolute path>" : JSON.stringify(bad)}) for an OAuth caller`, res.isError, res.text);
      }
    }
    tc = await callTool("delete_file", { path: "_m5_test/hello.txt" });
    check("delete_file works inside the workspace", !tc.isError && !(await exists(path.join(workspace, "_m5_test", "hello.txt"))), tc.text);
    check("package.json in the throwaway copy is unchanged", (await sha(copiedProjectJson)) === copiedBefore);
    check("the sentinel file outside the project is unchanged", (await fs.readFile(sentinel, "utf8").catch(() => "")) === "SENTINEL");
    r = await mcpCall(A, t.access_token + "x");
    check("a token with one extra character -> 401", r.status === 401);
    r = await mcpCall(A, t.access_token.slice(0, -1));
    check("a token with the last character missing -> 401", r.status === 401);
    r = await raw(A.port, "POST", "/mcp?access_token=" + t.access_token, { headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    check("an OAuth token in the URL is NOT accepted", r.status === 401, `${r.status}`);
    r = await mcpCall(A, null, undefined, { "X-Access-Token": t.access_token });
    check("an OAuth token in another header is NOT accepted", r.status === 401, `${r.status}`);
    r = await raw(A.port, "POST", "/mcp", { headers: { ...JSON_HEADERS, Authorization: `Basic ${Buffer.from("x:" + t.access_token).toString("base64")}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    check("an OAuth token sent with the wrong scheme (Basic) -> 401", r.status === 401, `${r.status}`);
    r = await mcpCall(A, t.refresh_token);
    check("a REFRESH token is not accepted as an access token", r.status === 401, `${r.status}`);

    // -----------------------------------------------------------------------
    section("Refresh tokens rotate, and reusing an old one revokes the grant");
    const rt1 = await getTokens(A, clientId);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: rt1.refresh_token, resource: resourceOf(A) });
    const rt2: Tokens = r.json;
    remember(rt2?.access_token, rt2?.refresh_token);
    check("a refresh token -> 200 with new tokens", r.status === 200 && !!rt2?.access_token, `${r.status} ${r.text}`);
    check("the new tokens are different from the old ones", rt2.access_token !== rt1.access_token && rt2.refresh_token !== rt1.refresh_token);
    r = await mcpCall(A, rt1.access_token);
    check("the old access token stops working after a refresh", r.status === 401, `${r.status}`);
    r = await mcpCall(A, rt2.access_token);
    check("the new access token works", r.status === 200, `${r.status}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: rt1.refresh_token });
    check("the OLD refresh token is refused", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await mcpCall(A, rt2.access_token);
    check("...and presenting it revoked the whole grant (the new access token is dead too)", r.status === 401, `${r.status}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: rt2.refresh_token });
    check("...and the new refresh token is dead too", r.status === 400 && !r.json?.access_token, `${r.status}`);

    const rf = await getTokens(A, clientId);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: otherClient, refresh_token: rf.refresh_token });
    check("another client cannot use this client's refresh token", r.status === 400 && !r.json?.access_token, `${r.status} ${r.text}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: rf.refresh_token, scope: "workspace admin" });
    check("asking for more scope than was granted -> 400 invalid_scope", r.status === 400 && r.json?.error === "invalid_scope", `${r.status} ${r.text}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: rf.refresh_token, resource: "https://other.example/mcp" });
    check("a refresh for a different resource -> 400 invalid_target", r.status === 400 && r.json?.error === "invalid_target", `${r.status} ${r.text}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: "no-such-client-" + rand(4), refresh_token: rf.refresh_token });
    check("an unknown client (for example after a server restart) -> 401 invalid_client, so Claude registers again", r.status === 401 && r.json?.error === "invalid_client", `${r.status} ${r.text}`);
    r = await tokenRequest(A, { grant_type: "authorization_code", client_id: "no-such-client-" + rand(4), code: "x", code_verifier: pkce().verifier, redirect_uri: CLAUDE_CALLBACK });
    check("...also for the code exchange", r.status === 401 && r.json?.error === "invalid_client", `${r.status} ${r.text}`);

    // -----------------------------------------------------------------------
    section("Revoking tokens");
    const rv = await getTokens(A, clientId);
    r = await raw(A.port, "POST", "/revoke", { headers: FORM_HEADERS, body: form({ client_id: otherClient, token: rv.access_token }) });
    r = await mcpCall(A, rv.access_token);
    check("another client cannot revoke this client's token", r.status === 200, `${r.status}`);
    r = await raw(A.port, "POST", "/revoke", { headers: FORM_HEADERS, body: form({ client_id: clientId, token: "not-a-real-token" }) });
    check("revoking an unknown token is harmless (200)", r.status === 200, `${r.status}`);
    r = await raw(A.port, "POST", "/revoke", { headers: FORM_HEADERS, body: form({ client_id: clientId, token: rv.access_token }) });
    check("/revoke with the right client -> 200", r.status === 200, `${r.status}`);
    r = await mcpCall(A, rv.access_token);
    check("a revoked access token -> 401", r.status === 401, `${r.status}`);
    r = await tokenRequest(A, { grant_type: "refresh_token", client_id: clientId, refresh_token: rv.refresh_token });
    check("revoking also cancelled the refresh token (the whole grant)", r.status === 400 && !r.json?.access_token, `${r.status}`);
    const rv2 = await getTokens(A, clientId);
    await raw(A.port, "POST", "/revoke", { headers: FORM_HEADERS, body: form({ client_id: clientId, token: rv2.refresh_token }) });
    r = await mcpCall(A, rv2.access_token);
    check("revoking the refresh token also cancels the access token", r.status === 401, `${r.status}`);

    // -----------------------------------------------------------------------
    section("Tokens live in memory only (a second server process does not know them)");
    {
      const E = await startOAuthServer();
      const mine = await getTokens(A, clientId);
      r = await mcpCall(E, mine.access_token);
      check("a token from one server process is rejected by another", r.status === 401, `${r.status}`);
      r = await mcpCall(E, STATIC_TOKEN);
      check("the fixed token works on both", r.status === 200, `${r.status}`);
      r = await tokenRequest(E, { grant_type: "refresh_token", client_id: clientId, refresh_token: mine.refresh_token });
      check("the other server does not know the client either (401 invalid_client)", r.status === 401 && r.json?.error === "invalid_client", `${r.status} ${r.text}`);
      E.child.kill();
      await E.exited;
    }

    // -----------------------------------------------------------------------
    section("Access tokens expire (separate server with a 3 second lifetime)");
    {
      const B = await startOAuthServer({ MCP_ACCESS_TOKEN_TTL_SECONDS: "3" });
      const cid = await newClientId(B);
      const tk = await getTokens(B, cid);
      check("the token response says it expires in 3 seconds", tk.expires_in === 3, String(tk.expires_in));
      r = await mcpCall(B, tk.access_token);
      check("a fresh token works", r.status === 200, `${r.status}`);
      await sleep(3600);
      r = await mcpCall(B, tk.access_token);
      check("the same token is rejected after it expires", r.status === 401 && String(r.headers["www-authenticate"] ?? "").includes("invalid_token"), `${r.status}`);
      r = await tokenRequest(B, { grant_type: "refresh_token", client_id: cid, refresh_token: tk.refresh_token, resource: resourceOf(B) });
      remember(r.json?.access_token, r.json?.refresh_token);
      check("the refresh token still works and gives a new access token", r.status === 200 && !!r.json?.access_token, `${r.status} ${r.text}`);
      r = await mcpCall(B, r.json?.access_token ?? "none");
      check("the new access token works", r.status === 200, `${r.status}`);
      B.child.kill();
      await B.exited;
    }

    // -----------------------------------------------------------------------
    section("Too many wrong owner passwords lock approvals (separate server)");
    {
      const C = await startOAuthServer();
      const cid = await newClientId(C);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const pg = await authorize(C, { client_id: cid, redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge, resource: resourceOf(C) });
        const wrong = "guess-" + rand(6);
        remember(wrong);
        const x = await consent(C, { request_id: requestIdOf(pg.text), password: wrong, decision: "approve" });
        statuses.push(x.status);
        check(`wrong password #${i + 1} gives no redirect`, !x.headers.location);
      }
      check("the first four wrong passwords -> 401 and the fifth -> 429", JSON.stringify(statuses) === JSON.stringify([401, 401, 401, 401, 429]), JSON.stringify(statuses));
      const g2 = await getCode(C, cid);
      check("after the lock, even the RIGHT password is refused (429, no code)", g2.consentReply.status === 429 && g2.code === "" && !g2.consentReply.headers.location, `${g2.consentReply.status}`);
      r = await mcpCall(C, STATIC_TOKEN);
      check("the lock does not affect the fixed token on /mcp", r.status === 200, `${r.status}`);
      C.child.kill();
      await C.exited;
    }

    // -----------------------------------------------------------------------
    section("Secrets never reach the log or the disk");
    const log = A.output();
    check("the server log has entries for the requests (and 401s)", /POST \/mcp -> 401/.test(log) && /POST \/consent -> /.test(log), log.slice(-300));
    const leaked = secrets.filter((s) => s.length >= 8 && log.includes(s));
    check("the log contains no password, token, code, verifier or approval request id", leaked.length === 0, `${leaked.length} secret(s) found in the log, for example "${leaked[0]?.slice(0, 6)}…"`);
    check("the log never shows an Authorization header or the word Bearer", !/authorization:|bearer/i.test(log));
    check("the log has paths only: no query strings (code_challenge, state, redirect_uri)", !/code_challenge|state=|redirect_uri|client_id=/.test(log));
    check("the log records the owner decisions without secrets", log.includes("the owner approved a connection request") && log.includes("a wrong owner password was entered"), log.slice(-400));
    check("the log has no stack traces", !/\n\s+at .*\(.*:\d+:\d+\)/.test(log));
    const diskContents = await readAllFiles(projectRoot, ["node_modules"]);
    const onDisk = secrets.filter((s) => s.length >= 8 && diskContents.some((f) => f.includes(s)));
    check("no password, token or code was written to any file in the project copy", onDisk.length === 0, `${onDisk.length} found`);
    check("no unexpected files were created next to the project copy", (await fs.readdir(tmpBase)).sort().join(",") === "outside-sentinel.txt,project");

    // -----------------------------------------------------------------------
    section("Clean shutdown");
    if (process.platform === "win32") {
      console.log("  SKIP  signals are not delivered on Windows; PM2 uses a shutdown message there");
    } else {
      A.child.kill("SIGTERM");
      const code = await Promise.race([A.exited, sleep(8000).then(() => "timeout" as const)]);
      check("SIGTERM stops the OAuth server cleanly (exit code 0)", code === 0, String(code) + " " + A.output().slice(-200));
    }

    // -----------------------------------------------------------------------
    section("Nothing outside the throwaway copy was touched");
    for (const f of realFiles) check(`REAL project file ${path.relative(sourceRoot, f)} was never touched`, (await exists(f)) && (await sha(f)) === realBefore.get(f));
    check("the sentinel file is unchanged", (await fs.readFile(sentinel, "utf8").catch(() => "")) === "SENTINEL");
  } catch (err) {
    failed++;
    console.log("Test runner crashed:", err);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    for (const s of started) if (s.child.exitCode === null) s.child.kill();
    await sleep(300);
    // Remove the link first (so nothing is ever followed into the real node_modules), then the temp folder.
    await fs.unlink(path.join(projectRoot, "node_modules")).catch(() => {});
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});