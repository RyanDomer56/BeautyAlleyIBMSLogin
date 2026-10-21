/**
 * Pre-commit secret scan.
 *
 * Reads every key/value out of `backend/.env` and greps the given files for the
 * literal values. A `.gitignore` is only as good as its last edit, so this
 * checks the actual *content* rather than the file names.
 *
 * The file list is read from **stdin**, because this sandbox blocks Node from
 * spawning subprocesses at all (`EBUSY` for every binary, including `node`
 * itself) — so the script cannot run `git` itself. The caller does:
 *
 *   git diff --cached --name-only | node scripts/secret-scan.js
 *
 * With no stdin it falls back to walking the working tree.
 *
 * Exits non-zero on a leak, so it can gate a commit.
 *
 * Usage: node scripts/secret-scan.js [paths-to-scan.txt]
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const envFile = path.join(__dirname, "..", ".env");

if (!fs.existsSync(envFile)) {
  console.error("no backend/.env found — nothing to scan against");
  process.exit(0);
}

// ---- collect the secret values ------------------------------------------
const values = [];
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) continue;
  const value = m[2].replace(/^["']|["']$/g, "");
  // Short values are noise (booleans, ports) and would match everywhere.
  if (value.length >= 12) values.push([m[1], value]);
}

if (!values.length) {
  console.log("no secret values long enough to check");
  process.exit(0);
}

/** Resolve a path from the list to something inside the repo root. */
function toAbs(file) {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

// ---- which files to scan ------------------------------------------------
// From an argument (a file containing one path per line), else stdin, else the
// whole working tree.
let files = [];
const argFile = process.argv[2];
if (argFile && fs.existsSync(argFile)) {
  files = fs.readFileSync(argFile, "utf8").split(/\r?\n/).filter(Boolean);
} else if (!process.stdin.isTTY) {
  let buf = "";
  try {
    buf = fs.readFileSync(0, "utf8");
  } catch {
    buf = "";
  }
  files = buf.split(/\r?\n/).filter(Boolean);
}

if (!files.length) {
  const skip = new Set(["node_modules", "dist", "coverage", "backups", ".verify", ".workbuddy-ai", ".tools-venv", ".git"]);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(path.relative(root, abs).replace(/\\/g, "/"));
    }
  })(root);
}

let scanned = 0;
let leaks = 0;
const leakLines = [];

const exts = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt",
  ".yml", ".yaml", ".env", ".example", ".sql", ".sh", ".py", ".html", ".css",
]);

for (const file of files) {
  const abs = toAbs(file);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  // Only text: binaries would produce false positives from random bytes.
  if (!exts.has(path.extname(file).toLowerCase())) continue;
  if (stat.size > 4_000_000) continue;

  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  scanned++;

  for (const [key, value] of values) {
    if (text.includes(value)) {
      leaks++;
      leakLines.push(`${key}  ->  ${file}`);
    }
  }
}

console.log("secret scan");
console.log(`  values checked  ${values.length} from backend/.env`);
console.log(`  files scanned   ${scanned} of ${files.length} given`);

if (leaks) {
  console.log(`  ${leaks} LEAK(S):`);
  for (const l of leakLines) console.log(`    ${l}`);
  process.exit(1);
}
console.log("  clean — no secret value appears in any staged file");
