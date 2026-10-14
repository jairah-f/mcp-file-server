// Entry point 2: MCP over Streamable HTTP (for ngrok / remote MCP clients).
//
// What this server answers:
//   POST /mcp                  the MCP endpoint (needs a credential, see below)
//   OAuth sign-in endpoints    ONLY when OAuth is configured (MCP_PUBLIC_URL + MCP_OWNER_PASSWORD):
//                              /.well-known/oauth-*, /register, /authorize, /consent, /token, /revoke
// Every other path answers 404. There is no static file serving and no other file API,
// so the only way to touch files is through the MCP tools, which all go through the
// workspace sandbox in tools.ts.
//
// Who may call POST /mcp (checked BEFORE the request body is read, and before any tool runs):
//   1. the fixed token from MCP_AUTH_TOKEN (used by the endpoint checker and the tests), OR
//   2. an OAuth access token that this server issued after the owner approved a connection
//      (only when OAuth is configured; the token must be meant for this server's /mcp address).
// Anything else gets 401. There is no unauthenticated fallback: without MCP_AUTH_TOKEN the server will not start.
//
// Stateless mode: every request gets its own fresh MCP server + transport.
// That keeps the code simple and means a restart (for example by PM2) loses nothing.
// (OAuth clients and tokens are the exception: they live in memory, so a restart means "reconnect" in Claude.)
import crypto from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ensureWorkspace, WORKSPACE_ROOT } from "./tools.js";
import { createMcpServer } from "./server-factory.js";
import { createOAuthApp, isOAuthPath, loadOAuthConfig, resourceMetadataUrl, sameResource, SCOPE } from "./oauth.js";
import type { OAuthConfig } from "./oauth.js";

const MCP_PATH = "/mcp";

// Use the configured host. Render requires 0.0.0.0 for public web services.
const HOST = process.env.HOST ?? "127.0.0.1";

// A 1 MB file (the tool limit) plus JSON overhead fits comfortably.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// PORT comes from the environment, default 3000.
function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid PORT "${value}". Use a whole number between 0 and 65535.`);
    process.exit(1);
  }
  return port;
}
const PORT = parsePort(process.env.PORT);

// ---------------------------------------------------------------------------
// Credentials (read once at start-up; the server refuses to start if they are unusable)
// ---------------------------------------------------------------------------

const MIN_TOKEN_LENGTH = 16;

// The fixed token. Never printed, never logged.
function loadAuthToken(): string {
  const token = (process.env.MCP_AUTH_TOKEN ?? "").trim();
  if (token === "") {
    console.error("MCP_AUTH_TOKEN is not set (or is empty). The HTTP server refuses to start without it, because it would be open to everyone.");
    console.error('PowerShell:  $env:MCP_AUTH_TOKEN = "<your-long-random-token>"   then start the server again. See README.md.');
    process.exit(1);
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error(`MCP_AUTH_TOKEN is too short. Use at least ${MIN_TOKEN_LENGTH} characters (see README.md for how to make a long random one).`);
    process.exit(1);
  }
  return token;
}
const AUTH_TOKEN = loadAuthToken();

// OAuth sign-in is optional: null means "not configured", so only the fixed token works.
// Half-configured or unsafe settings stop the server with a plain-English message (no secrets in it).
function loadOAuth(): OAuthConfig | null {
  try {
    return loadOAuthConfig(process.env);
  } catch (err) {
    console.error(`OAuth settings problem: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exit(1);
  }
}
const OAUTH_CONFIG = loadOAuth();
const OAUTH = OAUTH_CONFIG
  ? createOAuthApp(OAUTH_CONFIG, (message) => console.log(`${new Date().toISOString()} ${message}`))
  : null;

// Compare two secrets without leaking where they differ (both are hashed to the same length first).
function sameSecret(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
}

// "Authorization: Bearer <token>" -> the token, or null when the header is missing or shaped differently.
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Is this request allowed to use /mcp?  { ok: true }  or  { ok: false, presented }
// (presented = the caller sent a token, but it was not accepted).
async function authenticate(req: IncomingMessage): Promise<{ ok: true } | { ok: false; presented: boolean }> {
  const token = bearerToken(req);
  if (token === null) return { ok: false, presented: false };

  // 1. The fixed token.
  if (sameSecret(token, AUTH_TOKEN)) return { ok: true };

  // 2. An OAuth access token issued by this server (only when OAuth is configured).
  if (OAUTH && OAUTH_CONFIG) {
    try {
      const info = await OAUTH.provider.verifyAccessToken(token); // throws for unknown or expired tokens
      const forThisServer = info.resource !== undefined && sameResource(info.resource, OAUTH_CONFIG.resourceUrl);
      const hasScope = info.scopes.includes(SCOPE);
      const notExpired = info.expiresAt === undefined || info.expiresAt * 1000 > Date.now();
      if (forThisServer && hasScope && notExpired) return { ok: true };
    } catch {
      // not a valid OAuth token: fall through to "rejected"
    }
  }
  return { ok: false, presented: true };
}

// The WWW-Authenticate header of a 401. With OAuth on, it tells the caller where to find the sign-in information.
function challengeHeader(presented: boolean): string {
  let value = 'Bearer realm="mcp-file-server"';
  if (OAUTH_CONFIG) value += `, resource_metadata="${resourceMetadataUrl(OAUTH_CONFIG)}"`;
  if (presented) value += ', error="invalid_token"';
  return value;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// An error that should become a specific HTTP status.
class HttpError extends Error {
  status: number;
  rpcCode: number;
  constructor(status: number, message: string, rpcCode = -32600) {
    super(message);
    this.status = status;
    this.rpcCode = rpcCode;
  }
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

// Read the request body as JSON, refusing anything larger than MAX_BODY_BYTES.
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, "Request body is too large."));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        reject(new HttpError(413, "Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Request body is not valid JSON.", -32700));
      }
    });
    req.on("error", reject);
  });
}

// For the log line only: which MCP method (and tool name) was called.
// Tool ARGUMENTS and file contents are never logged.
function describeRpc(body: unknown): string {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .map((m) => {
      if (typeof m !== "object" || m === null) return "?";
      const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
      if (typeof method !== "string") return "response";
      if (method === "tools/call" && typeof params?.name === "string") return `${method}:${params.name}`;
      return method;
    })
    .join(",");
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse, info: { rpc: string }): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  // OAuth sign-in endpoints exist ONLY when OAuth is configured. They are handled by the OAuth module
  // (see oauth.ts), which has its own body-size limits and never touches the MCP tools.
  if (OAUTH && isOAuthPath(pathname)) {
    OAUTH.app(req, res);
    return;
  }

  // Otherwise only /mcp exists.
  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { error: `Not found. The only endpoint is ${MCP_PATH}.` });
    return;
  }

  // Stateless mode has no server-to-client stream or sessions, so only POST is allowed.
  if (req.method !== "POST") {
    sendJson(res, 405, jsonRpcError(-32000, "Method not allowed. Use POST."), { Allow: "POST" });
    return;
  }

  // Who is calling? This happens BEFORE the body is read, so an unauthenticated caller
  // cannot make the server read, parse or run anything.
  const auth = await authenticate(req);
  if (!auth.ok) {
    sendJson(res, 401, jsonRpcError(-32001, "Unauthorized. A valid access token is required."), {
      "WWW-Authenticate": challengeHeader(auth.presented),
      Connection: "close",
    });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof HttpError) {
      // For an oversized body, close the connection instead of reading the rest.
      const headers: Record<string, string> = err.status === 413 ? { Connection: "close" } : {};
      sendJson(res, err.status, jsonRpcError(err.rpcCode, err.message), headers);
      if (err.status === 413) res.once("finish", () => req.destroy());
      return;
    }
    throw err;
  }
  info.rpc = describeRpc(body);

  // A fresh server + transport per request (stateless mode).
const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no sessions
    enableJsonResponse: true, // plain JSON replies: simple and tunnel-friendly
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

const httpServer = http.createServer((req, res) => {
  const started = Date.now();
  const info = { rpc: "" };

  // One log line per request (method, path, status, time, MCP method).
  // Only the path is logged: never the query string, headers or body (codes and tokens can be in those).
  res.on("finish", () => {
    const pathname = (req.url ?? "/").split("?")[0];
    const rpc = info.rpc ? ` ${info.rpc}` : "";
    console.log(`${new Date().toISOString()} ${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started} ms)${rpc}`);
  });

  handleRequest(req, res, info).catch((err) => {
    // Details go to the log only; the client gets a generic message.
    console.error("Request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      sendJson(res, 500, jsonRpcError(-32603, "Internal server error."));
    } else {
      res.end();
    }
  });
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other program, or choose another port (for example PORT=3001).`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason} received, shutting down...`);
  OAUTH?.provider.dispose(); // stop the OAuth clean-up timer; clients and tokens are forgotten with the process
  httpServer.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  httpServer.closeIdleConnections();
  setTimeout(() => httpServer.closeAllConnections(), 2000).unref();
  setTimeout(() => process.exit(1), 5000).unref(); // last resort
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// PM2 on Windows asks for a shutdown with a message instead of a signal.
process.on("message", (msg) => {
  if (msg === "shutdown") shutdown("PM2 shutdown message");
});

async function main(): Promise<void> {
  await ensureWorkspace();
  console.log(`DEBUG HOST=${process.env.HOST ?? "(not set)"}, PORT=${process.env.PORT ?? "(not set)"}`);
  httpServer.listen(PORT, HOST, () => {
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`MCP File Server (Streamable HTTP) listening on http://${HOST}:${port}${MCP_PATH}`);
    console.log(`Workspace: ${WORKSPACE_ROOT}`);
    if (OAUTH_CONFIG) {
    console.log(`Sign-in: fixed token AND OAuth. Public address: ${OAUTH_CONFIG.publicUrl.origin}`);
    } else {
    console.log("Sign-in: fixed token only (OAuth is not configured).");
}
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});