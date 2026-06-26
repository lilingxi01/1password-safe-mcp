# 1Password Safe MCP

Local MCP server for a narrow browser-login workflow:

- list accessible 1Password vault item names
- describe field labels without returning values
- copy one selected field to the macOS clipboard

The server uses the pinned official `@1password/sdk` package. `copy_secret` reads the selected value inside the MCP server process, writes it to the macOS clipboard, and returns only metadata.

## Setup

The service account token is read from `.env`:

```sh
OP_SERVICE_ACCOUNT_TOKEN=ops_...
```

`ONEPASSWORD_SERVICE_ACCOUNT_TOKEN` and the previous `1PASSWORD_SERVICE_ACCOUNT_TOKEN` name are also accepted.

Install local Bun and the pinned SDK dependency:

```sh
./scripts/install-bun.sh
./vendor/bun/bun install
```

Run a local smoke test:

```sh
./vendor/bun/bun ./scripts/mcp-call.mjs tools/list '{}'
./vendor/bun/bun ./scripts/mcp-call.mjs list_secrets '{"vault":"Agents","limit":10}'
```

## MCP Tools

`list_secrets`

Lists vault names and item names visible to the service account. No values are returned.

`describe_secret`

Returns field labels, IDs, purposes, and types for a selected item. Values are stripped before the MCP response.

`copy_secret`

Requires the agent to paste into the destination input after this tool runs. It writes the selected field to the macOS clipboard without returning the value, and restores the previous clipboard after 30 seconds by default:

```json
{
  "vault": "Agents",
  "item": "AT&T",
  "field": "username",
  "restoreAfterSeconds": 30
}
```

You can also provide an `op://...` reference:

```json
{
  "secretRef": "op://Agents/AT&T/username",
  "field": "username"
}
```

## Codex Plugin

This repo is also a Codex plugin. The plugin manifest lives at `.codex-plugin/plugin.json`, and its bundled MCP config lives at `.mcp.json`.

For repo-local installation, add this repository as a local Codex marketplace root:

```sh
codex plugin marketplace add /Users/lingxi/repos/1password-safe-mcp
codex plugin add 1password-safe-mcp@1password-safe-mcp-local
```

Restart Codex or start a new thread after installing. The plugin starts the MCP server through:

```json
{
  "mcpServers": {
    "1password-safe": {
      "command": "./bin/1password-safe-mcp"
    }
  }
}
```

## Cursor Plugin

This repo is also a Cursor plugin. The plugin manifest lives at `.cursor-plugin/plugin.json`, and Cursor discovers the plugin MCP server from `mcp.json`.

For local testing, install or import this repository as a local Cursor plugin from the repo root. The bundled MCP server is named `1password-safe` and starts through `./bin/1password-safe-mcp`.

If you want to run the MCP server directly from Cursor project/global MCP config instead of installing the plugin, use this same shape:

```json
{
  "mcpServers": {
    "1password-safe": {
      "type": "stdio",
      "command": "/Users/lingxi/repos/1password-safe-mcp/bin/1password-safe-mcp",
      "envFile": "/Users/lingxi/repos/1password-safe-mcp/.env"
    }
  }
}
```

## Direct Codex Config

```toml
[mcp_servers."1password-safe"]
command = "/Users/lingxi/repos/1password-safe-mcp/bin/1password-safe-mcp"
```

## Runtime Choice

This project uses Bun for the MCP server because the official 1Password JavaScript SDK can be pinned and locked as a normal dependency. Rust does not buy much for the current shape because there is no native keyboard helper anymore; the only macOS-specific boundary is the pasteboard command.

## Security Notes

- The service account should be limited to a dedicated automation vault.
- The `@1password/sdk` dependency is pinned and locked in `bun.lock`.
- `copy_secret` does not return the secret to the agent.
- The selected secret still enters the global macOS clipboard and becomes visible to whatever app receives the paste.
- `copy_secret` uses the macOS pasteboard path and does not require Accessibility.
- There is no AppleScript, keyboard-event helper, or `.app` bundle.
