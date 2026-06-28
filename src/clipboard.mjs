import { spawn } from "node:child_process";

/**
 * Platform-aware system clipboard.
 *
 * macOS uses the built-in pbcopy/pbpaste. Linux has no single standard tool,
 * so the first available of wl-clipboard (Wayland), xclip, or xsel (X11) is
 * used. The selected backend is resolved once and cached per instance.
 *
 * Write note: some X11 tools (notably xclip) fork a background process to own
 * the selection and keep inherited stdout/stderr pipes open. Writes therefore
 * ignore the child's stdout/stderr and resolve as soon as the foreground
 * process exits, so the call never hangs.
 */
export class Clipboard {
  /** @type {ClipboardBackend[]} backends to probe on Linux, in priority order. */
  #linuxBackends;
  /** @type {ClipboardBackend} backend used on macOS. */
  #macBackend;
  /** @type {ClipboardBackend | undefined} resolved + cached backend. */
  #backend;
  /** @type {string} */
  #platform;

  constructor({ platform = process.platform } = {}) {
    this.#platform = platform;
    this.#macBackend = {
      name: "macos-pbcopy",
      write: (value) => this.#spawnWrite("/usr/bin/pbcopy", [], value),
      read: () => this.#spawnRead("/usr/bin/pbpaste", []),
    };
    this.#linuxBackends = [
      {
        name: "wl-clipboard",
        probe: "wl-copy",
        write: (value) => this.#spawnWrite("wl-copy", [], value),
        read: () => this.#spawnRead("wl-paste", ["--no-newline"]),
      },
      {
        name: "xclip",
        probe: "xclip",
        write: (value) => this.#spawnWrite("xclip", ["-selection", "clipboard"], value),
        read: () => this.#spawnRead("xclip", ["-selection", "clipboard", "-o"]),
      },
      {
        name: "xsel",
        probe: "xsel",
        write: (value) => this.#spawnWrite("xsel", ["--clipboard", "--input"], value),
        read: () => this.#spawnRead("xsel", ["--clipboard", "--output"]),
      },
    ];
  }

  /**
   * Resolve (and cache) the clipboard backend for the current platform.
   * @returns {Promise<ClipboardBackend>}
   */
  async backend() {
    if (this.#backend) {
      return this.#backend;
    }
    if (this.#platform === "darwin") {
      this.#backend = this.#macBackend;
      return this.#backend;
    }
    for (const backend of this.#linuxBackends) {
      if (await this.#hasCommand(backend.probe)) {
        this.#backend = backend;
        return this.#backend;
      }
    }
    const tried = this.#linuxBackends.map((b) => b.probe).join(", ");
    throw new Error(`No clipboard tool found. Install one of: ${tried} (Linux), or run on macOS.`);
  }

  /**
   * Write a value to the system clipboard.
   * @param {string} value
   */
  async write(value) {
    const backend = await this.backend();
    const result = await backend.write(value);
    if (result.code !== 0) {
      throw new Error(result.stderr?.trim() || `Failed to write clipboard via ${backend.name}`);
    }
  }

  /**
   * Read the current value of the system clipboard.
   * @returns {Promise<string>}
   */
  async read() {
    const backend = await this.backend();
    const result = await backend.read();
    return result.code === 0 ? result.stdout : "";
  }

  /** @param {string} command */
  async #hasCommand(command) {
    const result = await this.#spawnRead("/usr/bin/env", [
      "sh",
      "-c",
      `command -v ${command} 2>/dev/null`,
    ]);
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  #spawnWrite(command, args, input) {
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

  #spawnRead(command, args) {
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
}

/**
 * @typedef {Object} ClipboardBackend
 * @property {string} name
 * @property {string} [probe]
 * @property {(value: string) => Promise<{code: number, stderr?: string}>} write
 * @property {() => Promise<{code: number, stdout: string}>} read
 */

/** Shared default instance for the current process platform. */
export const clipboard = new Clipboard();
