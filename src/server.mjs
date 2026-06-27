import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readClipboardValue, writeClipboardValue } from "./clipboard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const INTEGRATION_NAME = "1Password Safe MCP";
const INTEGRATION_VERSION = "0.1.0";

loadDotEnv(join(PROJECT_DIR, ".env"));

let sdkClientPromise;

const tools = [
  {
    name: "list_secrets",
    description:
      "List 1Password vaults and item names visible to the service account. Does not return field values.",
    inputSchema: {
      type: "object",
      properties: {
        vault: {
          type: "string",
          description: "Optional vault title or ID to limit the listing.",
        },
        query: {
          type: "string",
          description: "Optional case-insensitive filter applied to item titles.",
        },
        limit: {
          type: "number",
          description: "Maximum number of items per vault to return. Defaults to 100.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "describe_secret",
    description:
      "Describe a 1Password item's field labels and metadata without returning values.",
    inputSchema: {
      type: "object",
      required: ["vault", "item"],
      properties: {
        vault: {
          type: "string",
          description: "Vault title or ID.",
        },
        item: {
          type: "string",
          description: "Item title or ID.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "copy_secret",
    description:
      "Read one selected 1Password field and copy it to the system clipboard (macOS or Linux). The value is never returned to the agent.",
    inputSchema: {
      type: "object",
      required: ["field"],
      properties: {
        vault: {
          type: "string",
          description: "Vault title or ID. Required unless secretRef is provided.",
        },
        item: {
          type: "string",
          description: "Item title or ID. Required unless secretRef is provided.",
        },
        field: {
          type: "string",
          description:
            "Field title, field ID, or field type to copy, for example username, email, or password.",
        },
        secretRef: {
          type: "string",
          description:
            "Optional op://vault/item/field reference resolved by the 1Password SDK. If set, vault and item are not required.",
        },
        restoreAfterSeconds: {
          type: "number",
          description:
            "Restore the previous clipboard after this many seconds. Defaults to 30. Set to 0 to disable.",
        },
      },
      additionalProperties: false,
    },
  },
];

const serverInfo = {
  name: "1password-safe-mcp",
  version: INTEGRATION_VERSION,
};

let nextBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  nextBuffer += chunk;
  for (;;) {
    const newline = nextBuffer.indexOf("\n");
    if (newline === -1) {
      break;
    }

    const line = nextBuffer.slice(0, newline).trim();
    nextBuffer = nextBuffer.slice(newline + 1);

    if (line.length === 0) {
      continue;
    }

    void handleLine(line);
  }
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeError(null, -32700, "Parse error", String(error?.message ?? error));
    return;
  }

  if (request.id === undefined) {
    return;
  }

  try {
    const result = await dispatch(request);
    writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    writeError(
      request.id,
      error?.code ?? -32603,
      error?.message ?? "Internal error",
      error?.safeDetails,
    );
  }
}

async function dispatch(request) {
  const method = request.method;
  const params = request.params ?? {};

  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo,
    };
  }

  if (method === "tools/list") {
    return { tools };
  }

  if (method === "tools/call") {
    const result = await callTool(params.name, params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  throw rpcError(-32601, `Unknown method: ${method}`);
}

async function callTool(name, args) {
  switch (name) {
    case "list_secrets":
      return await listSecrets(args);
    case "describe_secret":
      return await describeSecret(args);
    case "copy_secret":
      return await copySecret(args);
    default:
      throw rpcError(-32602, `Unknown tool: ${name}`);
  }
}

async function listSecrets(args) {
  const client = await getClient();
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 100;
  const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const vaults = args.vault ? [await resolveVault(args.vault)] : await listVaults();

  const results = [];
  for (const vault of vaults) {
    let items = [];
    try {
      items = await client.items.list(vault.id, activeItemFilter());
    } catch (error) {
      results.push({
        vault: vault.title,
        vaultId: vault.id,
        items: [],
        warning: errorMessage(error),
      });
      continue;
    }

    const filtered = [];
    for (const item of items) {
      const title = item.title ?? "";
      if (query && !title.toLowerCase().includes(query)) {
        continue;
      }
      filtered.push({
        title,
        id: item.id,
        category: item.category,
        vault: vault.title,
        vaultId: vault.id,
      });
      if (filtered.length >= limit) {
        break;
      }
    }

    results.push({
      vault: vault.title,
      vaultId: vault.id,
      count: filtered.length,
      items: filtered,
    });
  }

  return {
    provider: "1password-sdk",
    secretValuesReturned: false,
    vaults: results,
  };
}

async function describeSecret(args) {
  requireString(args.vault, "vault");
  requireString(args.item, "item");

  const client = await getClient();
  const vault = await resolveVault(args.vault);
  const overview = await resolveItem(vault.id, args.item);
  const item = await client.items.get(vault.id, overview.id);

  return {
    provider: "1password-sdk",
    secretValuesReturned: false,
    title: item.title,
    id: item.id,
    vault: vault.title,
    vaultId: vault.id,
    category: item.category,
    fields: collectFieldMetadata(item),
  };
}

async function copySecret(args) {
  requireString(args.field, "field");
  const restoreAfterSeconds = normalizeRestoreSeconds(args.restoreAfterSeconds);
  const value = await readSelectedSecret(args);
  if (value.length === 0) {
    throw rpcError(-32602, "Selected 1Password field is empty");
  }

  const previousClipboard = await readClipboard();
  await writeClipboard(value);

  if (restoreAfterSeconds > 0) {
    scheduleClipboardRestore(previousClipboard, restoreAfterSeconds);
  }

  return {
    provider: "1password-sdk",
    copied: true,
    secretValueReturned: false,
    charactersCopied: [...value].length,
    restoreScheduled: restoreAfterSeconds > 0,
    restoreAfterSeconds,
    field: args.field,
    item: args.secretRef ? undefined : args.item,
    vault: args.secretRef ? undefined : args.vault,
  };
}

async function readSelectedSecret(args) {
  const client = await getClient();

  if (typeof args.secretRef === "string" && args.secretRef.length > 0) {
    return await client.secrets.resolve(args.secretRef);
  }

  requireString(args.vault, "vault");
  requireString(args.item, "item");

  const vault = await resolveVault(args.vault);
  const overview = await resolveItem(vault.id, args.item);
  const item = await client.items.get(vault.id, overview.id);
  const field = findField(item, args.field);

  if (!field) {
    throw rpcError(-32602, `Field not found on item '${item.title}': ${args.field}`);
  }

  return String(field.value ?? "");
}

async function readClipboard() {
  return await readClipboardValue();
}

async function writeClipboard(value) {
  try {
    await writeClipboardValue(value);
  } catch (error) {
    throw rpcError(-32603, errorMessage(error) || "Failed to write clipboard");
  }
}

function scheduleClipboardRestore(previousClipboard, restoreAfterSeconds) {
  const restoreScript = join(PROJECT_DIR, "scripts", "clipboard-restore.mjs");
  const child = spawn(process.execPath, [restoreScript, String(restoreAfterSeconds)], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.stdin.end(previousClipboard);
  child.unref();
}

async function getClient() {
  if (!sdkClientPromise) {
    sdkClientPromise = createSdkClient();
  }
  return await sdkClientPromise;
}

async function createSdkClient() {
  const sdkModule = await import("@1password/sdk");
  const sdk = sdkModule.default ?? sdkModule;
  return await sdk.createClient({
    auth: requiredServiceAccountToken(),
    integrationName: INTEGRATION_NAME,
    integrationVersion: INTEGRATION_VERSION,
  });
}

async function listVaults() {
  const client = await getClient();
  return await client.vaults.list({ decryptDetails: true });
}

async function resolveVault(vault) {
  const vaults = await listVaults();
  const normalized = normalize(vault);
  const match = vaults.find((candidate) =>
    [candidate.id, candidate.title].map(normalize).includes(normalized),
  );
  if (!match) {
    throw rpcError(-32602, `Vault not found or not accessible: ${vault}`);
  }
  return match;
}

async function resolveItem(vaultId, item) {
  const client = await getClient();
  const items = await client.items.list(vaultId, activeItemFilter());
  const normalized = normalize(item);
  const matches = items.filter((candidate) =>
    [candidate.id, candidate.title].map(normalize).includes(normalized),
  );

  if (matches.length === 0) {
    throw rpcError(-32602, `Item not found or not accessible: ${item}`);
  }
  if (matches.length > 1) {
    throw rpcError(-32602, `More than one item matched '${item}'. Use the item ID.`);
  }
  return matches[0];
}

function activeItemFilter() {
  return {
    type: "ByState",
    content: {
      active: true,
      archived: false,
    },
  };
}

function collectFieldMetadata(item) {
  const sectionsById = new Map();
  for (const section of item.sections ?? []) {
    if (section?.id) {
      sectionsById.set(section.id, section.title ?? section.id);
    }
  }

  const fields = [];
  for (const field of item.fields ?? []) {
    fields.push({
      id: field.id,
      title: field.title,
      fieldType: field.fieldType,
      section: field.sectionId
        ? {
            id: field.sectionId,
            title: sectionsById.get(field.sectionId),
          }
        : undefined,
      valueReturned: false,
    });
  }
  return fields;
}

function findField(item, requested) {
  const normalized = normalize(requested);

  const exact = (item.fields ?? []).find((field) =>
    [field.id, field.title].map(normalize).includes(normalized),
  );
  if (exact) {
    return exact;
  }

  const byType = (item.fields ?? []).filter((field) => normalize(field.fieldType) === normalized);
  if (byType.length === 1) {
    return byType[0];
  }

  if (normalize(requested) === "password") {
    const concealed = (item.fields ?? []).filter((field) => field.fieldType === "Concealed");
    if (concealed.length === 1) {
      return concealed[0];
    }
  }

  return undefined;
}

function normalizeRestoreSeconds(value) {
  if (value === 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return 30;
  }
  return Math.min(300, Math.max(0, Math.floor(value)));
}

function requiredServiceAccountToken() {
  const token =
    process.env.OP_SERVICE_ACCOUNT_TOKEN ??
    process.env.ONEPASSWORD_SERVICE_ACCOUNT_TOKEN ??
    process.env["1PASSWORD_SERVICE_ACCOUNT_TOKEN"];
  if (!token) {
    throw rpcError(
      -32603,
      "1PASSWORD_SERVICE_ACCOUNT_TOKEN, OP_SERVICE_ACCOUNT_TOKEN, or ONEPASSWORD_SERVICE_ACCOUNT_TOKEN is not set. Put it in .env or the MCP process environment.",
    );
  }
  return token;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env: options.env,
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
    child.on("error", (error) => {
      reject(rpcError(-32603, `Failed to run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code !== 0 && options.rejectOnError !== false) {
        reject(rpcError(-32603, stderr.trim() || `${command} exited with ${code}`));
      } else {
        resolveRun(result);
      }
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw rpcError(-32602, `Missing required string argument: ${name}`);
  }
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function errorMessage(error) {
  return String(error?.message ?? error);
}

function loadDotEnv(path) {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function rpcError(code, message, safeDetails) {
  const error = new Error(message);
  error.code = code;
  error.safeDetails = safeDetails;
  return error;
}

function writeError(id, code, message, data) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
