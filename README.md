# zhengliang-canteen-mcp

面向数字食堂工作人员的本地 MCP。它通过官方登录页取得当前用户的会话 token，
在 Windows Credential Manager 或 macOS Keychain 中长期保存，并在本机提供采购、
台账、票证、委员会和预警工具。

本项目不保存账号密码，也不包含任何学校、供应商、人员、手机号、订单或证件样本。

## 安装

要求 Windows 10/11 或 macOS，以及 Node.js 20 以上版本。

```bash
npm install -g ./zhengliang-canteen-mcp-1.0.0.tgz
zhengliang-canteen-mcp setup --clients all
```

`setup` 会把专用 Chromium 安装到本项目自己的缓存目录，并注册：

- Codex
- Claude Code
- Claude Desktop

使用 `--dry-run` 可先预览所有配置变更：

```bash
zhengliang-canteen-mcp setup --clients all --dry-run
```

重启 MCP 客户端后，首次连接会打开官方数字食堂登录页。密码只提交给官方页面；
登录完成后会继续打开本机配置页，用于确认采购人、仓库收货人和台账人员。

## 常用命令

```bash
zhengliang-canteen-mcp doctor
zhengliang-canteen-mcp auth status
zhengliang-canteen-mcp auth login
zhengliang-canteen-mcp auth logout --confirm
zhengliang-canteen-mcp profile configure
zhengliang-canteen-mcp serve
```

## MCP 工具

- 认证与配置：`login`、`auth_status`、`logout`、`open_profile_setup`、
  `list_suppliers`、`list_warehouses`
- 采购查询：`list_orders`、`order_counts`、`query_goods`、`get_order`、
  `verify_order`、`raw_request`
- 采购操作：`match_goods`、`precheck_order`、`save_order`、`merge_items`、
  `delete_order`
- 台账：`save_morning_check`、`save_device_disinfection`、
  `save_waste_disposal`、`list_ledger_records`
- 票证：`scan_missing_tickets`、`get_order_ticket`、`update_order_ticket`
- 委员会：`get_committee`、`save_committee`
- 预警：`list_warnings`、`handle_warning`

所有采购订单只保存为草稿，不会提交或发起审批。删除、委员会保存、票证更新和
预警办理均保留显式 `confirm:true` 安全闸，并在写入后回查验收。

## 隐私与存储

- token：操作系统凭据库
- 学校专属默认值：AES-256-GCM 加密文件，密钥存入操作系统凭据库
- 浏览器：无痕上下文，独立 Chromium 缓存，不复用日常浏览器 profile
- 日志：不记录 token、手机号、姓名或业务明细
- 运行时业务数据：只在已授权用户的本机 MCP 响应中使用

服务端 token 过期或被撤销后会再次打开官方登录页；“长期保存”不代表绕过服务端
会话有效期。

## 开发验证

```bash
npm install
npm run verify
npm pack --dry-run
```

项目使用合成测试数据。禁止把生产响应、截图、账号、token 或业务导出放入仓库。

Author: luo qixiang
