import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, "pi/skills");

test("bundled skills live only under the declared packaged skill root", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./pi/skills"]);
  assert.ok(manifest.files.includes("pi/skills"));
  assert.ok(!manifest.files.includes("skills"));
  const dirs = (await readdir(skillRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(dirs, ["browser-assist", "browser-setup", "my-web-search", "pi-setup"]);
  for (const name of dirs) {
    const content = await readFile(path.join(skillRoot, name, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`^name: ${name}$`, "m"));
    await assert.rejects(access(path.join(root, "skills", name, "SKILL.md")), { code: "ENOENT" });
    for (const [, target] of content.matchAll(/\]\((references\/[^)]+)\)/g)) {
      await access(path.join(skillRoot, name, target));
    }
  }
});

test("researcher resolves the same bundled skill the package advertises", async () => {
  const loaderPath = path.join(root, "pi/extensions/subagents/trusted.ts");
  const source = await readFile(loaderPath, "utf8");
  const match = source.match(/"my-web-search": new URL\("([^"]+)", import\.meta\.url\)/);
  assert.ok(match, "researcher must use a package-relative bundled skill URL");
  const resolved = fileURLToPath(new URL(match[1], pathToFileURL(loaderPath)));
  assert.equal(resolved, path.join(skillRoot, "my-web-search/SKILL.md"));
  await access(resolved);
});

test("setup skill still locates owning manifest by walking ancestors", async () => {
  const content = await readFile(path.join(skillRoot, "pi-setup/SKILL.md"), "utf8");
  assert.match(content, /walk upward/);
  assert.match(content, /PACKAGE_ROOT\/package\.json/);
  let directory = path.join(skillRoot, "pi-setup");
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === "@irfansofyana/pi-setup") break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  assert.equal(directory, root);
  for (const marker of ["AGENTS.md", "README.md", "docs/setup", "pi/extensions", "pi/themes"]) {
    await access(path.join(directory, marker));
  }
});
