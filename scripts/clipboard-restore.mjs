import { clipboard } from "../src/clipboard.mjs";

const delaySeconds = Math.max(0, Number.parseInt(process.argv[2] ?? "0", 10));

let previous = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  previous += chunk;
});

await new Promise((resolve) => process.stdin.on("end", resolve));
await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));

try {
  await clipboard.write(previous);
} catch {
  // Best-effort restore; ignore failures (e.g. no clipboard tool available).
}
