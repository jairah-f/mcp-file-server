// Quick, READ-ONLY check that an MCP endpoint works. It connects like a real MCP
// client, lists the tools, and lists the workspace. It never writes or deletes anything.
//
// Usage:
//   npm run check:endpoint                                  checks http://127.0.0.1:3000/mcp
//   npm run check:endpoint -- https://YOUR-NGROK-DOMAIN/mcp checks your public ngrok URL
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://127.0.0.1:3000/mcp";

async function main(): Promise<void> {
  const client = new Client({ name: "check-endpoint", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    console.log(`Connected to ${url}`);

    const tools = (await client.listTools()).tools.map((t) => t.name);
    console.log(`Tools (${tools.length}): ${tools.join(", ")}`);

    const result = await client.callTool({ name: "list_files", arguments: { path: "." } });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    console.log(content.map((c) => c.text ?? "").join("\n"));

    console.log("\nOK: the endpoint is working.");
  } catch (err) {
    console.error(`\nFAILED to use ${url}`);
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

void main();