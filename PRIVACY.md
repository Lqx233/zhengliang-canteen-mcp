# Privacy Boundary

The repository, tests, logs, and release artifacts contain synthetic data only.
At runtime, authorized tenant data remains on the operator's computer and is
returned only when required by an MCP tool. Passwords are never handled by the
MCP process. Session tokens and tenant defaults must use operating-system-backed
encrypted storage.

