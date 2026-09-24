import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";

test("native toolchains retain locked packages for every advertised platform", async () => {
  const lock = JSON.parse(await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"));
  const families = [
    ["@github/copilot", "@github/copilot-"],
    ["rollup", "@rollup/rollup-"],
    ["esbuild", "@esbuild/"],
    ["koffi", "@koromix/koffi-"],
  ];
  function resolveDependency(parent, name) {
    for (let directory = parent; directory !== "."; directory = posix.dirname(directory)) {
      const dependency = lock.packages[`${directory}/node_modules/${name}`];
      if (dependency) return dependency;
    }
    return lock.packages[`node_modules/${name}`];
  }
  for (const [name, prefix] of families) {
    const path = `node_modules/${name}`;
    const parents = Object.entries(lock.packages).filter(([entry]) => entry === path || entry.endsWith(`/${path}`));
    assert.ok(parents.length, `${name} must remain in the locked build/runtime toolchain`);
    for (const [parentPath, parent] of parents) {
      const variants = Object.entries(parent.optionalDependencies ?? {}).filter(([variant]) => variant.startsWith(prefix));
      assert.ok(variants.length, `${parentPath} must declare its native variants`);
      for (const [variant, version] of variants) {
        const dependency = resolveDependency(parentPath, variant);
        assert.ok(dependency, `${parentPath} is missing ${variant}; regenerate optional metadata without node_modules`);
        assert.equal(dependency.version, version, `${parentPath} resolves an incompatible ${variant}`);
        if (variant.includes("linux")) assert.ok(dependency.integrity, `${variant} must retain its registry integrity hash for cloud builds`);
      }
    }
  }
});
