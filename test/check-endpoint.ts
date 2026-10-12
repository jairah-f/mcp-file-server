// Quick, READ-ONLY check that an MCP endpoint works. It connects like a real MCP
// client, lists the tools, and lists the workspace. It never writes or deletes anything.
//
// Usage:
//   npm run check:endpoint                                  checks http://127.0.0.1:3000/mcp
//   npm run check:endpoint -- https://YOUR-NGROK-DOMAIN/mcp checks your public ngrok URL
//
// The server requires a token (M5). Set the same value in this terminal first:
//   PowerShell:  $env:MCP_AUTH_TOKEN = "<your-token>"
// The token is only sent as a header. It is never printed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://127.0.0.1:3000/mcp";
const token = (process.env.MCP_AUTH_TOKEN ?? "").trim();

async function main(): Promise<void> {
  const client = new Client({ name: "check-endpoint", version: "1.0.0" });
  try {
    if (token === "") console.log("Note: MCP_AUTH_TOKEN is not set in this terminal, so no token is sent (the server will answer 401).");
    const headers: Record<string, string> = token === "" ? {} : { Authorization: `Bearer ${token}` };
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    console.log(`Connected to ${url}`);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    console.log(`Tools (${tools.length}): ${tools.join(", ")}`);

    const result = await client.callTool({ name: "list_files", arguments: { path: "." } });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    console.log(content.map((c) => c.text ?? "").join("\n"));

    console.log("\nOK: the endpoint is working.");
  } catch (err) {
    console.error(`\nFAILED to use ${url}`);
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    if (/401|unauthori[sz]ed/i.test(message)) {
      console.error("The server refused the token. Set MCP_AUTH_TOKEN in THIS terminal to the same value the server was started with.");
    }
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

void main();