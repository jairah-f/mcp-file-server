// Entry point 1: MCP over stdio (used by MCP Inspector and the M2 tests).
// For the remote/HTTP version see server-http.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, ensureWorkspace, WORKSPACE_ROOT } from "./tools.js";

async function main() {
  await ensureWorkspace();

  const server = createMcpServer();
  await server.connect(new StdioServerTransport());

  // stdout is reserved for the MCP protocol, so log to stderr only.
  console.error(`MCP File Server running (stdio). Workspace: ${WORKSPACE_ROOT}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});