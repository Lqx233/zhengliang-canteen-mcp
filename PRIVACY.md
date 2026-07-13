# Privacy Boundary

The repository, tests, logs, and release artifacts contain synthetic data only.
At runtime, authorized tenant data remains on the operator's computer and is
returned only when required by an MCP tool. Passwords are never handled by the
MCP process. Session tokens and tenant defaults must use operating-system-backed
encrypted storage.

The official login page runs in an ephemeral Playwright browser context. Only
the token field from the official origin's session storage is extracted. The
full browser session object, username, password, and tenant name are discarded.

Tenant defaults are encrypted with AES-256-GCM. The data-encryption key and the
session token are stored under the service name
`luo-qixiang.zhengliang-canteen-mcp` in the operating-system credential store.
There is no plaintext fallback.
