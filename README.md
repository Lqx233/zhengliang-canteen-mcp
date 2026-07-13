# zhengliang-canteen-mcp

[English](README_EN.md) | 简体中文

面向数字食堂系统工作人员的开源本地 MCP 服务。它通过官方浏览器登录取得当前用户的会话 token，为已授权用户提供采购、台账、票证、委员会和预警工具，不要求把系统账号密码写入 MCP 配置或项目文件。

作者：**luo qixiang**

## 功能概览

- 首次连接自动打开官方登录页，账号密码只提交给官方页面。
- token 保存到 macOS Keychain 或 Windows Credential Manager，可跨会话复用。
- 学校专属配置使用 AES-256-GCM 加密，密钥保存在操作系统凭据库。
- 动态读取当前账号可见的供应商和仓库，不包含租户专属静态数据。
- 提供 28 个 MCP 工具，覆盖采购、日常台账、票证、委员会和预警。
- 采购订单默认只保存草稿，高影响写操作要求显式确认并回查结果。

完整实现和开发文档位于 [`release/browser-auth-v1`](https://github.com/Lqx233/zhengliang-canteen-mcp/tree/release/browser-auth-v1) 分支。

## 系统要求

- macOS 或 Windows 10/11
- Node.js 20、22 或 24
- Codex、Claude Code 或 Claude Desktop
- 数字食堂系统的合法账号和访问权限

## 安装

```bash
npm install -g https://github.com/Lqx233/zhengliang-canteen-mcp/releases/download/v1.0.1/zhengliang-canteen-mcp-1.0.1.tgz
zhengliang-canteen-mcp doctor
```

安装包与 `SHA256SUMS.txt` 可在 [Releases](https://github.com/Lqx233/zhengliang-canteen-mcp/releases) 页面下载。

## 自动配置

安装独立 Chromium 并配置所有支持的客户端：

```bash
zhengliang-canteen-mcp setup --clients all
```

也可以只配置指定客户端：

```bash
zhengliang-canteen-mcp setup --clients codex
zhengliang-canteen-mcp setup --clients claude-code
zhengliang-canteen-mcp setup --clients claude-desktop
```

配置前预览变化：

```bash
zhengliang-canteen-mcp setup --clients all --dry-run
```

完成后重启对应客户端，MCP 注册名称为 `zhengliang-canteen-packaged`。

## 手动配置

先安装专用 Chromium：

```bash
zhengliang-canteen-mcp setup --clients none
```

Codex：

```bash
codex mcp add zhengliang-canteen-packaged -- zhengliang-canteen-mcp serve
```

Claude Code：

```bash
claude mcp add --scope user zhengliang-canteen-packaged -- zhengliang-canteen-mcp serve
```

Claude Desktop 配置：

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

配置文件位置：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

如果桌面应用无法识别 PATH，把 `command` 改为 `which zhengliang-canteen-mcp` 或 `where.exe zhengliang-canteen-mcp` 返回的绝对路径。

## 登录与 token

MCP 启动时会检查凭据库。没有有效 token 时会打开官方登录页；登录完成后只保存 token，并立即关闭无痕浏览器上下文。token 失效或被服务端撤销后会重新打开登录页。

```bash
zhengliang-canteen-mcp auth status
zhengliang-canteen-mcp auth login
zhengliang-canteen-mcp auth login --force
zhengliang-canteen-mcp auth logout --confirm
zhengliang-canteen-mcp profile configure
```

更完整的工具列表、隐私说明和开发方法见发布分支的[中文文档](https://github.com/Lqx233/zhengliang-canteen-mcp/blob/release/browser-auth-v1/README.md)与[英文文档](https://github.com/Lqx233/zhengliang-canteen-mcp/blob/release/browser-auth-v1/README_EN.md)。

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 luo qixiang。
