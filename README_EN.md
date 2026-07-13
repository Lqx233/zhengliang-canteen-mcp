# zhengliang-canteen-mcp

English | [简体中文](README.md)

An open-source local MCP server for authorized Digital Canteen staff. It uses the official browser login flow to obtain the current user's session token and provides purchasing, ledger, ticket, committee, and warning tools without placing system credentials in MCP configuration or project files.

## Highlights

- Opens the official login page automatically on first connection.
- Stores tokens in macOS Keychain or Windows Credential Manager for reuse.
- Encrypts tenant-specific settings with AES-256-GCM.
- Discovers suppliers and warehouses dynamically instead of shipping tenant data.
- Provides 28 MCP tools for purchasing and canteen operations.
- Saves purchase orders as drafts by default and protects high-impact writes with explicit confirmation.

The complete implementation and development documentation are maintained on the [`release/browser-auth-v1`](https://github.com/Lqx233/zhengliang-canteen-mcp/tree/release/browser-auth-v1) branch.

## Requirements

- macOS or Windows 10/11
- Node.js 20, 22, or 24
- Codex, Claude Code, or Claude Desktop
- A legitimate account authorized to access the Digital Canteen system

## Installation

```bash
npm install -g https://github.com/Lqx233/zhengliang-canteen-mcp/releases/download/v1.0.2/zhengliang-canteen-mcp-1.0.2.tgz
zhengliang-canteen-mcp doctor
```

The package and `SHA256SUMS.txt` are available from [GitHub Releases](https://github.com/Lqx233/zhengliang-canteen-mcp/releases).

## Automatic Configuration

Install the isolated Chromium build and configure every supported client:

```bash
zhengliang-canteen-mcp setup --clients all
```

Configure individual clients when needed:

```bash
zhengliang-canteen-mcp setup --clients codex
zhengliang-canteen-mcp setup --clients claude-code
zhengliang-canteen-mcp setup --clients claude-desktop
```

Preview changes first:

```bash
zhengliang-canteen-mcp setup --clients all --dry-run
```

Restart the client after setup. The MCP registration name is `zhengliang-canteen-packaged`.

## Manual Configuration

Install only the isolated Chromium build:

```bash
zhengliang-canteen-mcp setup --clients none
```

Codex:

```bash
codex mcp add zhengliang-canteen-packaged -- zhengliang-canteen-mcp serve
```

Claude Code:

```bash
claude mcp add --scope user zhengliang-canteen-packaged -- zhengliang-canteen-mcp serve
```

Claude Desktop:

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

Configuration file locations:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

If the desktop application cannot resolve shell PATH entries, replace `command` with the absolute path returned by `which zhengliang-canteen-mcp` or `where.exe zhengliang-canteen-mcp`.

## Login and Token Storage

At startup, the MCP checks the operating-system credential store. If no valid token is available, it opens the official login page. It stores only the resulting token and closes the ephemeral browser context. The browser login flow runs again only after the server expires or revokes the token.

```bash
zhengliang-canteen-mcp auth status
zhengliang-canteen-mcp auth login
zhengliang-canteen-mcp auth login --force
zhengliang-canteen-mcp auth logout --confirm
zhengliang-canteen-mcp profile configure
```

See the release branch's [Chinese documentation](https://github.com/Lqx233/zhengliang-canteen-mcp/blob/release/browser-auth-v1/README.md) and [English documentation](https://github.com/Lqx233/zhengliang-canteen-mcp/blob/release/browser-auth-v1/README_EN.md) for the complete tool list, privacy model, and development workflow.

## License

Released under the [MIT License](LICENSE).
