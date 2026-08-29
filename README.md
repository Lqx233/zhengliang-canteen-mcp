# zhengliang-canteen-mcp

[English](README_EN.md) | 简体中文

面向数字食堂系统工作人员的本地 MCP 服务。它连接官方数字食堂后台，为已授权用户提供采购、台账、票证、委员会和预警等工具，并通过浏览器完成登录，不要求把系统账号密码交给 MCP 客户端。

## 主要特性

- 首次连接自动打开官方登录页，账号密码只提交给官方页面。
- 登录 token 保存到 macOS Keychain 或 Windows Credential Manager。
- token 可跨会话复用；服务端判定失效后才重新打开登录页。
- 学校专属配置使用 AES-256-GCM 加密，密钥存入操作系统凭据库。
- 动态读取当前账号可见的供应商和仓库，不内置学校、人员或供应商数据。
- 提供原有采购、台账、票证、委员会和预警工具，并增加能力目录、只读通用查询和双阶段确认工作流。
- 采购订单默认只保存草稿；高影响写操作要求显式确认并在写入后回查。

实现源码位于 [`release/browser-auth-v1`](https://github.com/Lqx233/zhengliang-canteen-mcp/tree/release/browser-auth-v1) 分支。

## 系统要求

- macOS 或 Windows 10/11
- Node.js 20、22 或 24
- 已安装至少一个 MCP 客户端：Codex、Claude Code、Claude Desktop、TraeWork、QoderWork 或 WorkBuddy
- 拥有数字食堂系统的合法账号和访问权限

## 安装

从 GitHub Release 安装当前版本：

```bash
npm install -g https://github.com/Lqx233/zhengliang-canteen-mcp/releases/download/v1.1.0/zhengliang-canteen-mcp-1.1.0.tgz
```

确认命令可用：

```bash
zhengliang-canteen-mcp doctor
```

安装包和 `SHA256SUMS.txt` 可在 [Releases](https://github.com/Lqx233/zhengliang-canteen-mcp/releases) 页面下载。

## 自动配置

推荐使用内置配置器。它会安装独立 Chromium，并注册名称为 `zhengliang-canteen-packaged` 的 MCP：

```bash
zhengliang-canteen-mcp setup --clients all
```

也可以只配置指定客户端：

```bash
zhengliang-canteen-mcp setup --clients codex
zhengliang-canteen-mcp setup --clients claude-code
zhengliang-canteen-mcp setup --clients claude-desktop
zhengliang-canteen-mcp setup --clients codex,claude-code
zhengliang-canteen-mcp setup --clients trae
zhengliang-canteen-mcp setup --clients qoder
zhengliang-canteen-mcp setup --clients workbuddy
```

配置前预览所有变化：

```bash
zhengliang-canteen-mcp setup --clients all --dry-run
```

执行完成后重启对应的 MCP 客户端。

Trae/Qoder 的配置器会安装用户级 Skill，并打印官方 MCP 设置页可复制的 JSON 或 Qoder CLI 命令。WorkBuddy 会在系统临时目录生成参考材料包（包含 `skill.yml`、`SKILL.md`、工作流参考和示例 `mcp.json`）；这些材料不会自动注册，WorkBuddy 本身的设置仍需在官方界面中人工导入。

## 手动配置

自动配置不可用时，先只安装专用 Chromium：

```bash
zhengliang-canteen-mcp setup --clients none
```

查找可执行文件的绝对路径：

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

打开 Claude Desktop 配置文件：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

加入以下配置。桌面应用无法识别 PATH 时，把 `command` 改成上一步得到的绝对路径：

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

运行 `zhengliang-canteen-mcp setup --clients trae`，然后在 Trae 的 Settings → MCP 中添加自定义服务器并粘贴命令输出的 JSON。Skill 会安装到用户级目录 `~/.trae/skills/zhengliang-canteen/`。Trae 不接受包含空格的 `command`；如果 Node.js 的绝对路径含空格，配置器会自动改用 `node`，保留 CLI 的绝对路径作为参数，此时必须确保 Node.js 位于 Trae 可见的 `PATH` 中。TraeWork 的 Local/Cloud 运行环境由官方客户端选择；本地 stdio MCP 只能在 Local 环境使用。

### QoderWork / Qoder IDE / Qoder CLI

运行 `zhengliang-canteen-mcp setup --clients qoder`。Skill 会分别安装到：

- QoderWork：`~/.qoderwork/skills/zhengliang-canteen/`
- Qoder IDE/CLI：`~/.qoder/skills/zhengliang-canteen/`

随后在 QoderWork 的 Extensions → Connectors → + Add → Paste JSON Config，或 Qoder IDE 的 MCP 设置中粘贴命令输出的 JSON。Qoder CLI 不接受这段 JSON；请使用配置器打印的 `qoder mcp add <name> -- <command> <args...>` 命令，并确保 `PLAYWRIGHT_BROWSERS_PATH` 已在运行环境中设置。

### WorkBuddy

运行 `zhengliang-canteen-mcp setup --clients workbuddy`，命令会生成一个临时目录并打印路径。将其中的 `skill.yml`、`SKILL.md` 和 `references/` 作为参考材料通过 WorkBuddy 官方 Skill 界面上传；`mcp.json` 仅是示例，如果 Connectors 页面提供自定义 MCP 导入，请在官方界面中审核后手动导入。命令不会自动注册 WorkBuddy 设置，包内不含账号、密码或会话 token。

## 首次登录

MCP 启动后会检查操作系统凭据库。没有有效 token 时，会自动打开官方数字食堂登录页：

1. 在官方页面输入账号和密码。
2. 登录成功后，MCP 只读取官方页面生成的会话 token。
3. 浏览器登录上下文立即关闭，账号密码不会写入本项目。
4. 首次使用会打开本机配置页，用于确认采购人、仓库收货人和台账人员。
5. 以后启动会复用凭据库中的 token，直到服务端将其判定为过期或撤销。

也可以主动管理登录状态：

```bash
zhengliang-canteen-mcp auth status
zhengliang-canteen-mcp auth login
zhengliang-canteen-mcp auth login --force
zhengliang-canteen-mcp auth logout --confirm
zhengliang-canteen-mcp profile configure
```

## MCP 工具

- 认证与配置：`login`、`auth_status`、`logout`、`open_profile_setup`、`list_suppliers`、`list_warehouses`
- 采购查询：`list_orders`、`order_counts`、`query_goods`、`get_order`、`verify_order`、`raw_request`
- 采购操作：`match_goods`、`precheck_order`、`save_order`、`merge_items`、`delete_order`
- 台账：`save_morning_check`、`save_device_disinfection`、`save_waste_disposal`、`list_ledger_records`
- 票证：`scan_missing_tickets`、`get_order_ticket`、`update_order_ticket`
- 委员会：`get_committee`、`save_committee`
- 预警：`list_warnings`、`handle_warning`
- 能力与安全工作流：`list_capabilities`、`query_capability`、`prepare_action`、`execute_action`

`zhengliang://capabilities` 和 `zhengliang://security` resources 提供当前审计能力与安全边界；`canteen_workflow` prompt 用于引导读优先和确认门控流程。新增写能力默认不开放通用执行，必须使用其专用工具。

`query_capability` 仅接受能力 ID 和经该能力严格校验的 `params`。标记为 `confirmable` 的写能力使用 `prepare_action`/`execute_action`；标记为 `dedicated` 的能力继续使用其专用工具和内置门禁。

## 隐私与安全

- 仓库、测试和 Release 只包含合成数据。
- 不保存系统账号、密码、学校名称、真实人员、手机号、供应商、订单或证件样本。
- token 不会出现在日志、MCP 响应、URL 或普通文件中。
- 浏览器使用无痕上下文和独立缓存，不复用日常浏览器 profile。
- 写请求在重新登录后不会自动重放，避免重复写入。

详细说明见 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

## 开发验证

```bash
npm install
npm run verify
npm pack --dry-run
npm run audit:site
```

## 许可证

本项目采用 [MIT License](LICENSE)。
