import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const fail = (message) => {
  throw new Error(`Package verification failed: ${message}`);
};

const expected = {
  name: "@haneoka/altair-plugin-history",
  repository: "git+https://github.com/haneoka-gakuen/altair-plugin-history.git",
  peers: ["@haneoka/altair"],
  imports: ["@haneoka/altair/model", "@haneoka/altair/plugins"],
};

if (manifest.name !== expected.name) fail(`name must be ${expected.name}`);
if (manifest.license !== "MPL-2.0") fail("license must be MPL-2.0");
if (manifest.private === true) fail("package cannot be private");
if (manifest.sideEffects !== false) fail("sideEffects must be false");
if (manifest.repository?.url !== expected.repository) {
  fail(`repository.url must be ${expected.repository}`);
}
if (manifest.publishConfig?.access !== "public") {
  fail("publishConfig.access must be public");
}
if (manifest.publishConfig?.provenance !== true) {
  fail("publishConfig.provenance must be enabled");
}
if (manifest.altair?.pluginApi !== 2) {
  fail("altair.pluginApi must be 2");
}
if (manifest.altair?.kind !== "service") {
  fail("altair.kind must be service");
}
if (JSON.stringify(manifest.altair?.capabilities) !== JSON.stringify(["services"])) {
  fail("altair.capabilities must be exactly services");
}
if (!Array.isArray(manifest.altair?.permissions) || manifest.altair.permissions.length !== 0) {
  fail("history service must request no permissions");
}

const forbiddenDependency = /(?:live2d|cubism|motionsync|@esotericsoftware|spine|pixi)/iu;
for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (forbiddenDependency.test(name)) {
      fail(`forbidden SDK/runtime dependency ${name} in ${section}`);
    }
  }
}
if (Object.keys(manifest.dependencies ?? {}).length !== 0) {
  fail("runtime dependencies are not allowed");
}
if (Object.keys(manifest.optionalDependencies ?? {}).length !== 0) {
  fail("optional runtime dependencies are not allowed");
}
for (const field of ["bundledDependencies", "bundleDependencies"]) {
  if (Array.isArray(manifest[field]) && manifest[field].length > 0) {
    fail(`${field} must be empty`);
  }
}
const peers = Object.keys(manifest.peerDependencies ?? {}).sort();
if (JSON.stringify(peers) !== JSON.stringify(expected.peers)) {
  fail(`peer dependencies must be exactly ${expected.peers.join(", ")}`);
}

const exportTargets = (value) => {
  if (typeof value === "string") {
    return value.startsWith("./dist/") ? [value] : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
};
const targets = new Set(
  [manifest.main, manifest.module, manifest.types, ...exportTargets(manifest.exports)].filter(
    (value) => typeof value === "string" && value.startsWith("./dist/"),
  ),
);
if (targets.size === 0) fail("manifest has no dist export targets");
for (const target of targets) {
  try {
    await access(resolve(root, target));
  } catch {
    fail(`manifest references missing output ${target}`);
  }
}

const insideRoot = (path) => {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !pathFromRoot.startsWith(sep))
  );
};
const restrictedPath =
  /(?:^|\/)(?:assets?|character-models?|game-assets?|models?|sdk|vendor|textures?|motions?|physics|runtime|core)(?:\/|$)|\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp3|ogg|wav|m4a|mp4|webm|moc|moc3|model3\.json|motion3\.json|physics3\.json|cdi3\.json|exp3\.json|skel|atlas|wasm|dll|dylib|so|node)$/iu;
const ignoredRoots = new Set([".dependencies", ".git", "coverage", "dist", "node_modules"]);
const repositoryFiles = [];

const walkRepository = async (path, relativePath = "") => {
  if (!insideRoot(path)) fail(`path escapes repository: ${path}`);
  const information = await lstat(path);
  if (information.isSymbolicLink()) {
    fail(`symbolic links are not allowed: ${relativePath}`);
  }
  if (information.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (!relativePath && ignoredRoots.has(entry)) continue;
      await walkRepository(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
    }
    return;
  }
  repositoryFiles.push(relativePath);
};
await walkRepository(root);
const restrictedRepositoryFiles = repositoryFiles.filter((path) => restrictedPath.test(path));
if (restrictedRepositoryFiles.length > 0) {
  fail(`restricted SDK, runtime, model, or asset payload:\n${restrictedRepositoryFiles.join("\n")}`);
}

const publishableFiles = [];
let publishableBytes = 0;
const walkPublishable = async (path, relativePath) => {
  if (!insideRoot(path)) fail(`publish path escapes: ${relativePath}`);
  const canonical = await realpath(path);
  if (!insideRoot(canonical)) {
    fail(`publish path resolves outside repository: ${relativePath}`);
  }
  const information = await lstat(path);
  if (information.isSymbolicLink()) {
    fail(`publish path is a symbolic link: ${relativePath}`);
  }
  if (information.isDirectory()) {
    for (const entry of await readdir(path)) {
      await walkPublishable(resolve(path, entry), relativePath ? `${relativePath}/${entry}` : entry);
    }
    return;
  }
  publishableFiles.push(relativePath);
  publishableBytes += (await stat(path)).size;
  if ((await readFile(path)).includes(0)) {
    fail(`binary payload found in ${relativePath}`);
  }
};
for (const entry of manifest.files ?? []) {
  if (typeof entry !== "string" || !entry || entry.startsWith("/")) {
    fail(`invalid package files entry ${String(entry)}`);
  }
  const path = resolve(root, entry);
  if (!insideRoot(path)) fail(`package files entry escapes: ${entry}`);
  await walkPublishable(path, entry);
}
const restrictedPublishableFiles = publishableFiles.filter((path) => restrictedPath.test(path));
if (restrictedPublishableFiles.length > 0) {
  fail(`restricted publish payload:\n${restrictedPublishableFiles.join("\n")}`);
}
if (publishableBytes > 5 * 1024 * 1024) {
  fail(`publish payload is unexpectedly large (${publishableBytes} bytes)`);
}

const builtJavaScript = await readFile(resolve(root, "dist/index.js"), "utf8");
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu;
const imports = new Set(
  [...builtJavaScript.matchAll(importPattern)]
    .map((match) => match[1])
    .filter((specifier) => specifier !== undefined && !specifier.startsWith(".")),
);
const unexpectedImports = [...imports].filter((specifier) => !expected.imports.includes(specifier));
if (unexpectedImports.length > 0) {
  fail(`unexpected runtime imports: ${unexpectedImports.join(", ")}`);
}
if (!builtJavaScript.includes("haneoka.altair-history")) {
  fail("built plugin id is missing");
}
if (!builtJavaScript.includes("haneoka.altair.history")) {
  fail("built service id is missing");
}

console.log(
  `Verified ${manifest.name}: ${targets.size} exports, ${publishableFiles.length} files, ${publishableBytes} bytes.`,
);
