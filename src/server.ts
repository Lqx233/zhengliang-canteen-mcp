import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_NAME, VERSION } from "./constants.js";
import { log } from "./logger.js";
import { createRuntime } from "./runtime.js";
import { BASE_TOOLS } from "./tools/base.js";
import { PURCHASE_TOOLS } from "./tools/purchase.js";
import { LEDGER_TOOLS } from "./tools/ledger.js";
import { TICKET_TOOLS } from "./tools/tickets.js";
import { COMMITTEE_TOOLS } from "./tools/committee.js";
import { WARNING_TOOLS } from "./tools/warnings.js";
import { err, type ToolDefinition } from "./tools/shared.js";

export const ALL_TOOLS: ToolDefinition[] = [
  ...BASE_TOOLS,
  ...PURCHASE_TOOLS,
  ...LEDGER_TOOLS,
  ...TICKET_TOOLS,
  ...COMMITTEE_TOOLS,
  ...WARNING_TOOLS,
];

export async function serve(): Promise<void> {
  const context = createRuntime();
  const server = new McpServer({ name: APP_NAME, version: VERSION }, { capabilities: { tools: {} } });
  for (const tool of ALL_TOOLS) {
    server.tool(tool.name, tool.description, tool.schema as any, async (args: any) => {
      try {
        return await tool.handler(args, context);
      } catch (error: any) {
        log("tool_failed", { tool: tool.name, errorType: error?.name ?? "Error" });
        return err(error?.message ?? `Tool ${tool.name} failed`);
      }
    });
  }
  await server.connect(new StdioServerTransport());
  log("mcp_ready", { toolCount: ALL_TOOLS.length, version: VERSION });
  void context.session.ensureToken()
    .then(async () => {
      if (!await context.vault.load()) await context.wizard.open();
    })
    .catch((error) => log("startup_auth_pending", { errorType: error?.name ?? "Error" }));
}
