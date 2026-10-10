// Builds the complete MCP server used by BOTH entry points (stdio and HTTP):
//   M2: five core file tools           (tools.ts)
//   M4: agent handoff tools            (handoff.ts)
//   M4: git-lite tools                 (git-tools.ts)
//   M4: search tool                    (search.ts)
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCoreServer } from "./tools.js";
import { registerHandoffTools } from "./handoff.js";
import { registerGitTools } from "./git-tools.js";
import { registerSearchTools } from "./search.js";

export function createMcpServer(): McpServer {
  const server = createCoreServer();
  registerHandoffTools(server);
  registerGitTools(server);
  registerSearchTools(server);
  return server;
}