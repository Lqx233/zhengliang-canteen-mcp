import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APP_NAME, VERSION } from "./constants.js";
import { log } from "./logger.js";
import { createRuntime } from "./runtime.js";
import { BASE_TOOLS } from "./tools/base.js";
import { PURCHASE_TOOLS } from "./tools/purchase.js";
import { LEDGER_TOOLS } from "./tools/ledger.js";
import { TICKET_TOOLS } from "./tools/tickets.js";
import { COMMITTEE_TOOLS } from "./tools/committee.js";
import { WARNING_TOOLS } from "./tools/warnings.js";
import { CAPABILITY_TOOLS } from "./tools/capabilities.js";
import { capabilitySummary } from "./capabilities.js";
import { err, type ToolContext, type ToolDefinition } from "./tools/shared.js";

export const ALL_TOOLS: ToolDefinition[] = [
  ...BASE_TOOLS,
  ...PURCHASE_TOOLS,
  ...LEDGER_TOOLS,
  ...TICKET_TOOLS,
  ...COMMITTEE_TOOLS,
  ...WARNING_TOOLS,
  ...CAPABILITY_TOOLS,
];

export function toolAnnotations(effect: ToolDefinition["effect"]) {
  if (effect === "read") return { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  if (effect === "preview") return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  if (effect === "local-write") return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  if (effect === "local-destructive") return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  if (effect === "remote-delete") return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
}

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: APP_NAME, version: VERSION }, { capabilities: { tools: {} } });
  for (const tool of ALL_TOOLS) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.schema as any,
      annotations: toolAnnotations(tool.effect),
    }, async (args: any) => {
      try {
        return await tool.handler(args, context);
      } catch (error: any) {
        log("tool_failed", { tool: tool.name, errorType: error?.name ?? "Error" });
        return err(error?.message ?? `Tool ${tool.name} failed`);
      }
    });
  }
  server.registerResource("capabilities", "zhengliang://capabilities", {
    title: "Audited Digital Canteen capabilities",
    description: "Reviewed official-site capabilities; no tenant data.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ version: 1, origin: "https://admin.zhenglianginfo.com", capabilities: capabilitySummary() }, null, 2) }] }));
  server.registerResource("security", "zhengliang://security", {
    title: "Digital Canteen MCP safety rules",
    description: "Credential, confirmation, and verification boundaries.",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Safety rules\n\n- Passwords stay on the official login page; only the session token is stored.\n- Read operations use the reviewed capability registry.\n- Confirmable capabilities use prepare_action followed by execute_action with confirm:true.\n- Dedicated write capabilities use their named safety-checked tool and its built-in confirmation gate.\n- A refreshed session never replays a write automatically.\n- Stop and report uncertainty whenever post-write verification fails.\n" }] }));
  server.registerPrompt("canteen_workflow", {
    title: "Safe canteen workflow",
    description: "Guide a read-first, confirmation-gated Digital Canteen task.",
    argsSchema: { request: z.string().optional() },
  }, async (args: any) => ({ messages: [{ role: "user", content: { type: "text", text: `Use the zhengliang-canteen MCP for this request: ${String(args?.request ?? "")}\nFirst inspect capabilities and current state. For confirmable capabilities, use prepare_action and wait for explicit confirmation before execute_action. For dedicated writes, use the named tool's safety checks and confirmation gate. Stop on failed verification and never expose credentials or tokens.` } }] }));
  return server;
}

export async function serve(): Promise<void> {
  const context = createRuntime();
  const server = createServer(context);
  await server.connect(new StdioServerTransport());
  log("mcp_ready", { toolCount: ALL_TOOLS.length, version: VERSION });
  void context.session.ensureToken()
    .then(async () => {
      if (!await context.vault.load()) await context.wizard.open();
    })
    .catch((error) => log("startup_auth_pending", { errorType: error?.name ?? "Error" }));
}
