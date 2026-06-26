---
name: 1password-safe
description: Use when a task needs a login or secret from 1Password via the 1password-safe MCP server without exposing the value in chat.
---

# 1Password Safe

Use the `1password-safe` MCP server for narrow login and credential lookup tasks.

## Workflow

1. Use `list_secrets` to find accessible vaults and item names. Apply `vault`, `query`, and `limit` when the user gives enough context.
2. Use `describe_secret` to inspect field labels and IDs. Treat every returned field as metadata only.
3. Use `copy_secret` only for the one field the user needs pasted or supplied to another local UI.
4. After `copy_secret`, tell the user or the controlling browser/computer workflow to paste from the macOS clipboard.

## Guardrails

- Never ask the server to return raw secret values; this MCP intentionally does not expose them.
- Do not print, summarize, transform, or infer the secret value from clipboard contents.
- Prefer `OP_SERVICE_ACCOUNT_TOKEN` in `.env` or the client process environment.
- If the field cannot be found, list the available field labels and ask for the exact one to copy.
- Keep clipboard exposure brief by using the default restore timer unless the user asks otherwise.
