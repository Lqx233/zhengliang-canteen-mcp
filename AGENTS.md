# Repository Rules

- Never add production credentials, tokens, tenant names, supplier identifiers,
  person names, phone numbers, orders, certificates, or API response dumps.
- Use synthetic fixtures only. Values used in tests must be visibly fictitious.
- Passwords must remain in the official browser page. The MCP process may store
  only the resulting session token.
- Raw tokens must never appear in logs, errors, MCP responses, URLs, or files.
- System writes require their existing confirmation and verification gates.
- Run `npm run verify` and inspect `npm pack --dry-run` before publishing.
