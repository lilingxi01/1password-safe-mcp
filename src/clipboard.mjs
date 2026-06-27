import { spawn } from "node:child_process";

// Platform-aware clipboard helpers.
//
// macOS uses the built-in pbcopy/pbpaste. Linux has no single standard tool,
// so we probe for the common ones at runtime: wl-clipboard (Wayland), then
// xclip, then xsel (X11). The first available pair is used.
//
// Write note: some X11 tools (notably xclip) fork a background process to own
// the selection and keep inherited stdout/stderr pipes open. To avoid hanging,
// writes ignore the child's stdout/stderr and resolve as soon as the foreground
// process exits.

function spawnWrite(command, args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch (error) {
      resolve({ code: 127, stderr: String(error?.message ?? error) });
      return;
    }
    let settled = false;
    const done = (code, stderr = "") => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr });
    };
    child.on("error", (error) => done(127, String(error?.message ?? error)));
    child.on("close", (code) => done(code ?? 0));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function spawnRead(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve({ code: 127, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout }));
  });
}

async function hasCommand(command) {
  const result = await spawnRead("/usr/bin/env", ["sh", "-c", `command -v ${command} 2>/dev/null`]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

const MAC_BACKEND = {
  name: "macos-pbcopy",
  write: (value) => spawnWrite("/usr/bin/pbcopy", [], value),
  read: () => spawnRead("/usr/bin/pbpaste", []),
};

const LINUX_BACKENDS = [
  {
    name: "wl-clipboard",
    probe: "wl-copy",
    write: (value) => spawnWrite("wl-copy", [], value),
    read: () => spawnRead("wl-paste", ["--no-newline"]),
  },
  {
    name: "xclip",
    probe: "xclip",
    write: (value) => spawnWrite("xclip", ["-selection", "clipboard"], value),
    read: () => spawnRead("xclip", ["-selection", "clipboard", "-o"]),
  },
  {
    name: "xsel",
    probe: "xsel",
    write: (value) => spawnWrite("xsel", ["--clipboard", "--input"], value),
    read: () => spawnRead("xsel", ["--clipboard", "--output"]),
  },
];

let cachedBackend;

export async function resolveClipboardBackend() {
  if (cachedBackend) {
    return cachedBackend;
  }
  if (process.platform === "darwin") {
    cachedBackend = MAC_BACKEND;
    return cachedBackend;
  }
  for (const backend of LINUX_BACKENDS) {
    if (await hasCommand(backend.probe)) {
      cachedBackend = backend;
      return cachedBackend;
    }
  }
  const tried = LINUX_BACKENDS.map((b) => b.probe).join(", ");
  throw new Error(`No clipboard tool found. Install one of: ${tried} (Linux), or run on macOS.`);
}

export async function writeClipboardValue(value) {
  const backend = await resolveClipboardBackend();
  const result = await backend.write(value);
  if (result.code !== 0) {
    throw new Error(result.stderr?.trim() || `Failed to write clipboard via ${backend.name}`);
  }
}

export async function readClipboardValue() {
  const backend = await resolveClipboardBackend();
  const result = await backend.read();
  return result.code === 0 ? result.stdout : "";
}
