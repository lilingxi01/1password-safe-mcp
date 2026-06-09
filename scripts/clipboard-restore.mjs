import { spawn } from "node:child_process";

const delaySeconds = Math.max(0, Number.parseInt(process.argv[2] ?? "0", 10));

let previous = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  previous += chunk;
});

await new Promise((resolve) => process.stdin.on("end", resolve));
await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));

const child = spawn("/usr/bin/pbcopy", [], {
  stdio: ["pipe", "ignore", "ignore"],
});
child.stdin.end(previous);
await new Promise((resolve) => child.on("close", resolve));
