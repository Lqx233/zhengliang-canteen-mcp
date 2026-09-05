# Privacy Boundary

The repository, tests, logs, and release artifacts contain synthetic data only.
At runtime, authorized tenant data remains on the operator's computer and is
returned only when required by an MCP tool. Passwords are never handled by the
MCP process. Session tokens and tenant defaults must use operating-system-backed
encrypted storage.

The official login page runs in an ephemeral Playwright browser context. Only
the token field from the official origin's session storage is extracted. The
full browser session object, username, password, and tenant name are discarded.

Tenant defaults are encrypted with AES-256-GCM. The data-encryption key and
ordinary session tokens are stored under the service name
`zhengliang-canteen-mcp` in the operating-system credential store. Tokens above
the Windows UTF-16 capacity limit, or rejected with a known capacity error, are
encrypted with the existing configuration key under the application data
directory's `sessions/` folder. Each save uses a fresh IV and authenticated data
bound to the official origin, profile and token purpose. Files contain only
ciphertext and encryption metadata; keys stay in the OS credential store.
Directories and files are created with modes 0700 and 0600 where supported;
Windows access follows the user's application-data directory permissions.
Logout removes both token locations without deleting the configuration key.
There is no plaintext fallback; other storage errors stop authentication.
