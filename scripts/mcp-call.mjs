import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const [toolName, rawArgs = "{}"] = process.argv.slice(2);

if (!toolName) {
  console.error("usage: node scripts/mcp-call.mjs <tool-name|tools/list> '<json-args>'");
  process.exit(64);
}

const args = JSON.parse(rawArgs);
const child = spawn(join(PROJECT_DIR, "bin", "1password-safe-mcp"), [], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const messages = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "local-mcp-call", version: "0.1.0" },
    },
  },
  toolName === "tools/list"
    ? { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    : {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      },
];

for (const message of messages) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
child.stdin.end();

const exitCode = await new Promise((resolveExit) => {
  child.on("close", resolveExit);
});

if (stderr.trim()) {
  console.error(stderr.trim());
}

const lines = stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const response = lines.find((line) => line.id === 2) ?? lines.at(-1);
if (response) {
  console.log(JSON.stringify(response, null, 2));
}

process.exit(exitCode ?? 0);
