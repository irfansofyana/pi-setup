import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function buildCiSuites(root, sdkVersion) {
  // Only these experimental routed-lease tests require Pi 1.1.0. Native floor
  // still runs every other extension test, including browser and task panels.
  const floorExclusions = new Set([
    "pi/extensions/subagents/headroom-backend.test.ts",
    "pi/extensions/subagents/route-transport.test.ts",
  ]);
  const extensions = readdirSync(resolve(root, "pi/extensions"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(resolve(root, "pi/extensions", entry.name))
      .filter(file => file.endsWith(".test.ts"))
      .map(file => `pi/extensions/${entry.name}/${file}`))
    .filter(file => sdkVersion !== "1.0.0" || !floorExclusions.has(file)).sort();
  return [
    { name: "Browser SDK import", command: process.execPath, args: ["--input-type=module", "-e", 'const m = await import("./pi/extensions/browser/index.ts"); if (typeof m.default !== "function") throw new Error("Missing browser entrypoint");'] },
    { name: "Package contracts", command: "npm", args: ["run", "test:package"] },
    { name: "Prompt templates", command: "npm", args: ["run", "test:prompts"] },
    { name: "Extensions", command: process.execPath, args: ["--experimental-transform-types", "--test", "--test-concurrency=1", ...extensions] },
    { name: "Subagent manager", command: "npm", args: ["run", "test:subagent-manager"] },
    { name: "Signature", command: "npm", args: ["run", "test:signature"] },
  ];
}

export function runCiSuites(suites, { run = spawnSync, log = console.log } = {}) {
  const failed = [];
  for (const suite of suites) {
    log(`::group::${suite.name}`);
    const result = run(suite.command, suite.args, { stdio: "inherit", timeout: 300_000 });
    log("::endgroup::");
    if (result.status !== 0 || result.error || result.signal) {
      failed.push(suite.name);
      log(`Failed: ${suite.name} (exit ${result.status ?? "none"}${result.signal ? `, ${result.signal}` : ""})`);
    }
  }
  log(failed.length ? `Failed suites: ${failed.join(", ")}` : "All CI suites passed.");
  return failed;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const sdkVersion = process.env.PI_VERSION;
  if (!sdkVersion) throw new Error("PI_VERSION is required; run this entrypoint inside the bounded CI container.");
  process.exitCode = runCiSuites(buildCiSuites(process.cwd(), sdkVersion)).length ? 1 : 0;
}
