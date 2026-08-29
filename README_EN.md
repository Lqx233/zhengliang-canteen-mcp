# zhengliang-canteen-mcp

English | [简体中文](README.md)

A local MCP server for authorized Digital Canteen staff. It connects to the official administration system and provides tools for purchasing, daily ledgers, tickets, committees, and warnings without asking users to give their system passwords to an MCP client.

## Features

- Opens the official login page automatically on the first connection.
- Keeps passwords inside the official page and stores only the resulting session token.
- Stores tokens in macOS Keychain or Windows Credential Manager for reuse across sessions.
- Encrypts tenant-specific settings with AES-256-GCM; the key stays in the operating-system credential store.
- Discovers suppliers and warehouses dynamically instead of shipping tenant-specific mappings.
- Provides the original purchasing, ledger, ticket, committee, and warning tools plus an audited capability registry, read-only generic queries, and two-phase write confirmations.
- Saves purchase orders as drafts by default and requires explicit confirmation for high-impact writes.

## Client Support

This project connects to the clients below through standard stdio MCP. `setup --clients all` covers every client in the table; you can also select one or more clients. “Automatic” means this project can write or generate the relevant configuration—it does not bypass the client's own official confirmation flow.

| Client | MCP configuration | Skill / materials | Setup behavior |
| --- | --- | --- | --- |
| Codex | `codex mcp add` | `~/.codex/skills/zhengliang-canteen/` | Registers MCP and installs the Skill automatically |
| Claude Code | `claude mcp add --scope user` | — | Registers MCP automatically |
| Claude Desktop | `claude_desktop_config.json` | — | Merges configuration and backs up the previous file |
| TraeWork / Trae IDE | Paste JSON in Settings → MCP | `~/.trae/skills/zhengliang-canteen/` | Installs the Skill and prints copy-ready JSON |
| QoderWork | Paste JSON in Extensions → Connectors | `~/.qoderwork/skills/zhengliang-canteen/` | Installs the Skill and prints copy-ready JSON |
| Qoder IDE | Paste JSON in MCP settings | `~/.qoder/skills/zhengliang-canteen/` | Installs the Skill and prints copy-ready JSON |
| Qoder CLI | `qoder mcp add <name> -- <command> <args...>` | `~/.qoder/skills/zhengliang-canteen/` | Installs the Skill and prints an executable command (not JSON) |
| WorkBuddy | Official Skill / Connectors UI | Reference materials in a temporary directory | Creates reference materials; does not auto-register |

Quick start:

```bash
# Preview without changing files
zhengliang-canteen-mcp setup --clients all --dry-run

# Configure every supported client
zhengliang-canteen-mcp setup --clients all

# Configure selected clients (comma-separated)
zhengliang-canteen-mcp setup --clients codex,workbuddy
```

Trae, Qoder, and WorkBuddy still require the final step in their official UI or shell workflow shown by the command. WorkBuddy's `mcp.json` is an example configuration, not a client database file; review it before uploading or importing it.

The packaged implementation is maintained on the [`release/browser-auth-v1`](https://github.com/Lqx233/zhengliang-canteen-mcp/tree/release/browser-auth-v1) branch.

## Requirements

- macOS or Windows 10/11
- Node.js 20, 22, or 24
- Codex, Claude Code, Claude Desktop, TraeWork, QoderWork, or WorkBuddy
- A legitimate account authorized to access the Digital Canteen system

## Installation

Install the current package from GitHub Releases:

```bash
npm install -g https://github.com/Lqx233/zhengliang-canteen-mcp/releases/download/v1.1.0/zhengliang-canteen-mcp-1.1.0.tgz
```

Check the installation:

```bash
zhengliang-canteen-mcp doctor
```

The package and `SHA256SUMS.txt` are also available from the [Releases](https://github.com/Lqx233/zhengliang-canteen-mcp/releases) page.

## Automatic Configuration

The built-in setup command installs an isolated Chromium build and registers the MCP as `zhengliang-canteen-packaged`:

```bash
zhengliang-canteen-mcp setup --clients all
```

Configure individual clients when needed:

```bash
zhengliang-canteen-mcp setup --clients codex
zhengliang-canteen-mcp setup --clients claude-code
zhengliang-canteen-mcp setup --clients claude-desktop
zhengliang-canteen-mcp setup --clients codex,claude-code
zhengliang-canteen-mcp setup --clients trae
zhengliang-canteen-mcp setup --clients qoder
zhengliang-canteen-mcp setup --clients workbuddy
```

Preview configuration changes without writing them:

```bash
zhengliang-canteen-mcp setup --clients all --dry-run
```

Restart the configured MCP client after setup completes.

Trae/Qoder setup installs user-level Skills and prints copy-ready JSON for the official MCP settings UI or an exact Qoder CLI command. WorkBuddy setup creates a temporary reference-materials bundle containing `skill.yml`, `SKILL.md`, workflow references, and an example `mcp.json`; nothing is registered automatically, and WorkBuddy settings are still imported manually through its official UI.

## Manual Configuration

If automatic registration is unavailable, install only the isolated Chromium build first:

```bash
zhengliang-canteen-mcp setup --clients none
```

Find the absolute executable path:

```bash
# macOS
which zhengliang-canteen-mcp

# Windows PowerShell
where.exe zhengliang-canteen-mcp
```

### Codex

```bash
codex mcp add zhengliang-canteen-packaged -- zhengliang-canteen-mcp serve
```

### Claude Code

```bash
claude mcp add --scope user zhengliang-canteen-packaged -- zhengliang-canteen-mcp serve
```

### Claude Desktop

Open the Claude Desktop configuration file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the entry below. If the desktop application cannot resolve shell PATH entries, replace `command` with the absolute executable path found above.

```json
{
  "mcpServers": {
    "zhengliang-canteen-packaged": {
      "command": "zhengliang-canteen-mcp",
      "args": ["serve"]
    }
  }
}
```

### TraeWork / Trae IDE

Run `zhengliang-canteen-mcp setup --clients trae`, then open Settings → MCP in Trae and paste the JSON printed by the command. The Skill is installed at `~/.trae/skills/zhengliang-canteen/`. Trae rejects a `command` containing spaces; when the absolute Node.js path contains spaces, setup automatically uses `node` and keeps the absolute CLI path in `args`, so Node.js must be available on Trae's `PATH`. TraeWork's Local/Cloud execution mode is selected by the official client; local stdio MCP servers require Local mode.

### QoderWork / Qoder IDE / Qoder CLI

Run `zhengliang-canteen-mcp setup --clients qoder`. Skills are installed at:

- QoderWork: `~/.qoderwork/skills/zhengliang-canteen/`
- Qoder IDE/CLI: `~/.qoder/skills/zhengliang-canteen/`

In QoderWork, use Extensions → Connectors → + Add → Paste JSON Config. In Qoder IDE, use the MCP settings page and paste the JSON. Qoder CLI does not accept that JSON; run the exact `qoder mcp add <name> -- <command> <args...>` command printed by setup, with `PLAYWRIGHT_BROWSERS_PATH` set in its runtime environment.

### WorkBuddy

Run `zhengliang-canteen-mcp setup --clients workbuddy`. The command creates a temporary reference-materials directory and prints its path. Upload `skill.yml`, `SKILL.md`, and `references/` through WorkBuddy's official Skill interface. `mcp.json` is an example only; if Connectors exposes custom MCP import, review it and import it manually through the official UI. The command does not register WorkBuddy settings, and the materials contain no account, password, or session token.

## First Login

At startup, the MCP checks the operating-system credential store. If no valid token is available, it opens the official Digital Canteen login page automatically:

1. Enter the account and password on the official page.
2. After login, the MCP reads only the session token created by that page.
3. The ephemeral browser context closes immediately; credentials are not written by this project.
4. On first use, a local configuration page opens for purchaser, warehouse receiver, and ledger defaults.
5. Later sessions reuse the stored token until the server expires or revokes it.

Authentication and profile commands:

```bash
zhengliang-canteen-mcp auth status
zhengliang-canteen-mcp auth login
zhengliang-canteen-mcp auth login --force
zhengliang-canteen-mcp auth logout --confirm
zhengliang-canteen-mcp profile configure
```

## MCP Tools

- Authentication and setup: `login`, `auth_status`, `logout`, `open_profile_setup`, `list_suppliers`, `list_warehouses`
- Purchase queries: `list_orders`, `order_counts`, `query_goods`, `get_order`, `verify_order`, `raw_request`
- Purchase operations: `match_goods`, `precheck_order`, `save_order`, `merge_items`, `delete_order`
- Ledgers: `save_morning_check`, `save_device_disinfection`, `save_waste_disposal`, `list_ledger_records`
- Tickets: `scan_missing_tickets`, `get_order_ticket`, `update_order_ticket`
- Committees: `get_committee`, `save_committee`
- Warnings: `list_warnings`, `handle_warning`
- Capability and safety workflow: `list_capabilities`, `query_capability`, `prepare_action`, `execute_action`

The `zhengliang://capabilities` and `zhengliang://security` resources expose the reviewed capability surface and safety boundary. The `canteen_workflow` prompt guides read-first, confirmation-gated use. New writes are not enabled through arbitrary generic execution and must use a dedicated safety-checked tool.

`query_capability` accepts only a capability ID and capability-specific validated `params`. Write capabilities marked `confirmable` use `prepare_action`/`execute_action`; capabilities marked `dedicated` continue to use their named tool and built-in gates.

## Privacy and Security

- The repository, tests, and release artifacts contain synthetic data only.
- No system accounts, passwords, school names, real people, phone numbers, suppliers, orders, or certificate samples are stored.
- Tokens never appear in logs, MCP responses, URLs, or plaintext files.
- Browser login uses an ephemeral context and an isolated cache.
- Write requests are not replayed automatically after reauthentication.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) for details.

## Development

```bash
npm install
npm run verify
npm pack --dry-run
npm run audit:site
```

## License

Released under the [MIT License](LICENSE).
