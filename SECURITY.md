# Security

Do not commit credentials, session tokens, tenant names, supplier identifiers,
person names, phone numbers, order data, certificates, or production responses.

Report suspected credential exposure privately to the repository owner. Revoke
the affected Digital Canteen session before sharing diagnostic details.

The HTTP client sends credentials only to `https://admin.zhenglianginfo.com` and
rejects cross-origin redirects. Write requests are not automatically replayed
after authentication recovery. The caller must verify state before retrying.
