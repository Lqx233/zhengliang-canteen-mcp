# Audited workflows

## Procurement

- Resolve supplier and warehouse from live discovery; never invent codes or names.
- Match goods against the live catalogue. Unresolved or price-deviating items stay blocked for human review.
- Keep new orders as drafts unless the user explicitly asks for a later official-page step. Re-check duplicate drafts before saving.
- Order creation uses the dedicated `save_order` workflow after `precheck_order`; it is not routed through `prepare_action`.
- Ticket edits require the existing ticket to be read first and the result to be queried again after the write.

## Ledgers

- Query the record for the requested date before creating a daily entry.
- Reuse a recent complete template only after checking that its fields are compatible with the current ledger type.
- Never fabricate employees, quantities, temperatures, times, attachments, or disposal evidence. Synthetic values are for tests only.
- Morning checks require actual per-employee `records` (see README input schema). Templates identify employees only; do not derive clinical results, temperatures, or times from them. Missing or ambiguous employee records block saving. Existing-day rebuilds require both `force:true` and `confirm:true`.
- Report whether the post-write record was found and which submitted fields were verified, including identity and actual quantities.

## Warnings and committees

- Filter warnings by the live status returned by the server; do not infer that a missing record is safe.
- Committee updates must target an existing term and preserve required role/member constraints.
- If the account lacks a permission, return the permission boundary and stop instead of trying another endpoint.

## Failure handling

- A refreshed session may retry reads, but never replays a write automatically.
- Only explicitly classified reads retry rate limits, within a 30-second total API budget including response bodies and backoff. Never automatically resend writes after transport failures.
- Authentication changes invalidate prepared confirmation handles. Prepare again after logging in or out.
- On an unexpected response shape, preserve the HTTP status and safe status/info fields and stop; do not pass through raw HTML or headers.
- A write accepted by the server but not found with the expected fields during verification is uncertain, not successful. Report it once and do not retry the write.
