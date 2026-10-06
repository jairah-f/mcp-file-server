// Entry point 2: MCP over Streamable HTTP (for ngrok / remote MCP clients).
//
// The ONLY thing this server exposes is the MCP endpoint:   POST /mcp
// Every other path answers 404. There is no static file serving and no other
// file API, so the only way to touch files is through the five MCP tools,
// which all go through the workspace sandbox in tools.ts.
//
// Stateless mode: every request gets its own fresh MCP server + transport.
// That keeps the code simple and means a restart (for example by PM2) loses nothing.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, ensureWorkspace, WORKSPACE_ROOT } from "./tools.js";

const MCP_PATH = "/mcp";

// Listen on this computer only. ngrok runs on the same computer and forwards
// to this address, so nothing else on your network can reach the server directly.
const HOST = "127.0.0.1";

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

  // Only /mcp exists.
  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { error: `Not found. The only endpoint is ${MCP_PATH}.` });
    return;
  }

  // Stateless mode has no server-to-client stream or sessions, so only POST is allowed.
  if (req.method !== "POST") {
    sendJson(res, 405, jsonRpcError(-32000, "Method not allowed. Use POST."), { Allow: "POST" });
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
  httpServer.listen(PORT, HOST, () => {
    const address = httpServer.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`MCP File Server (Streamable HTTP) listening on http://${HOST}:${port}${MCP_PATH}`);
    console.log(`Workspace: ${WORKSPACE_ROOT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});