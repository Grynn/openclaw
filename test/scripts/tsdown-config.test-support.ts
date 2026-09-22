export const FS_SAFE_CALLER_PROBE = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [entry, observer, rootDir, mode, outcome, sealed] = process.argv.slice(1);
if (sealed) registerHooks({ resolve(specifier, context, next) {
  if (!isBuiltin(specifier) && specifier !== pathToFileURL(entry).href)
    throw new Error("sealed dependency escaped: " + specifier);
  return next(specifier, context);
}});
const { root, parseJsonWithJson5Fallback, resolvePreferredOpenClawTmpDir, resolveRuntimeProcessEntrypointUrl } = await import(pathToFileURL(entry).href);
if (sealed) {
  assert.deepEqual(parseJsonWithJson5Fallback("{value:'bundled',}"), {value:"bundled"});
  assert.equal(resolvePreferredOpenClawTmpDir({preferredDir:rootDir, tmpdir:()=>rootDir, platform:"linux"}), rootDir);
  assert.equal(resolveRuntimeProcessEntrypointUrl("githubExec").href, new URL("./github-exec-launcher.mjs", pathToFileURL(entry)).href);
  assert.equal(resolveRuntimeProcessEntrypointUrl("serviceChildRelay").href, new URL("./service-child-relay.mjs", pathToFileURL(entry)).href);
}
const { configureFsSafeNative, getFsSafeNativeConfig, FsSafeError } = await import(pathToFileURL(observer).href);
assert.equal(getFsSafeNativeConfig().mode, mode === "configured" ? "off" : mode);
if (mode === "configured") configureFsSafeNative({ mode: "require" });
const scoped = await root(rootDir);
if (outcome === "missing") {
  await assert.rejects(scoped.write("proof.txt", "native proof"), (error) => {
    assert(error instanceof FsSafeError);
    assert.equal(error.code, "helper-unavailable");
    assert.equal(error.cause?.code, "MODULE_NOT_FOUND");
    return true;
  });
  assert.deepEqual(fs.readdirSync(rootDir), []);
} else {
  await scoped.write("proof.txt", "native proof");
  await scoped.create("created.txt", "create proof");
  assert.equal(fs.readFileSync(path.join(rootDir, "proof.txt"), "utf8"), "native proof");
  assert.equal(fs.readFileSync(path.join(rootDir, "created.txt"), "utf8"), "create proof");
}
const loaded = Object.keys(createRequire(import.meta.url).cache).filter((file) => file.endsWith("fs-safe-native.node"));
assert.equal(loaded.length, outcome === "native" ? 1 : 0);
if (loaded.length) assert(loaded[0].startsWith(path.dirname(rootDir) + path.sep));
`;
