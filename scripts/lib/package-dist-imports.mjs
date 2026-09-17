// Scans packaged JavaScript for relative imports and missing closure entries.
import { createRequire } from "node:module";
import path from "node:path";
import { visitModuleSpecifiers } from "./guard-inventory-utils.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const JS_FILE_RE = /\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function hasJavaScriptFileExtension(value) {
  return /\.(?:cjs|js|mjs)$/u.test(path.posix.basename(stripSpecifierSuffix(value)));
}

// openclaw.mjs probes `.js`/`.mjs` build alternates under dist/ through literal
// import()s and tolerates a direct miss, so a build ships only one format and may
// inline the warning filter and root help. Only the CLI entry is mandatory.
const LAUNCHER_PATH = "openclaw.mjs";
const LAUNCHER_ENTRY_ALTERNATES = ["dist/entry.js", "dist/entry.mjs"];
const LAUNCHER_OPTIONAL_PROBES = new Set([
  ...LAUNCHER_ENTRY_ALTERNATES,
  "dist/warning-filter.js",
  "dist/warning-filter.mjs",
  "dist/cli/program/root-help.js",
  "dist/cli/program/root-help.mjs",
]);

function isOptionalLauncherProbe(importerPath, importedPath) {
  return importerPath === LAUNCHER_PATH && LAUNCHER_OPTIONAL_PROBES.has(importedPath);
}

function appendImportEdges(source, importerPath, imports) {
  const sourceFile = ts.createSourceFile(
    importerPath,
    source,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    ts.ScriptKind.JS,
  );
  visitModuleSpecifiers(
    ts,
    sourceFile,
    ({ kind, specifier }) => {
      if (
        !specifier.startsWith(".") ||
        (kind === "import-meta-url" && !hasJavaScriptFileExtension(specifier))
      ) {
        return;
      }
      const importedPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(importerPath), stripSpecifierSuffix(specifier)),
      );
      // stageManagedHandoffRuntime copies this entry and stages its private Koffi
      // closure before launch; this URL belongs to that runtime, not the tarball.
      if (
        kind === "import-meta-url" &&
        importerPath === "dist/managed-handoff-runtime.mjs" &&
        importedPath === "dist/node_modules/koffi/indirect.cjs"
      ) {
        return;
      }
      if (kind !== "import-meta-url" || importedPath.startsWith("dist/")) {
        imports.push({ importerPath, importedPath });
      }
    },
    { includeCommonJs: true, includeImportMetaUrl: true },
  );
}

/** Collect missing-file errors for relative imports inside package files. */
export function collectPackageDistImportErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const errors = [];
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });

  for (const { importerPath, importedPath } of imports) {
    if (fileSet.has(importedPath) || isOptionalLauncherProbe(importerPath, importedPath)) {
      continue;
    }
    errors.push(`${importerPath} imports missing ${importedPath}`);
  }
  if (fileSet.has(LAUNCHER_PATH) && !LAUNCHER_ENTRY_ALTERNATES.some((file) => fileSet.has(file))) {
    errors.push(`${LAUNCHER_PATH} has no CLI entry (${LAUNCHER_ENTRY_ALTERNATES.join(" or ")})`);
  }

  return errors;
}

/** Collect relative dist import edges from package JavaScript files. */
export function collectPackageDistImports(params) {
  const files =
    params.files.length === 1
      ? [normalizePackagePath(params.files[0])]
      : [...new Set(params.files.map(normalizePackagePath))].toSorted((left, right) =>
          left.localeCompare(right),
        );
  const imports = [];

  for (const importerPath of files) {
    if (!JS_FILE_RE.test(importerPath) || /(?:^|\/)node_modules\//u.test(importerPath)) {
      continue;
    }
    const source = params.readText(importerPath);
    appendImportEdges(source, importerPath, imports);
  }

  return imports;
}
