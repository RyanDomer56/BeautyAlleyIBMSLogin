#!/usr/bin/env node
"use strict";

/**
 * Database backup.
 *
 * Two formats, because the right one depends on the machine:
 *
 *   1. `pg_dump` (custom format) - the real thing. Restores with `pg_restore`,
 *      preserves types and constraints, and is what you want for a production
 *      drill. Used automatically when `pg_dump` is on PATH or `PG_DUMP` is set.
 *   2. JSON snapshot - a fallback for machines with no PostgreSQL client
 *      installed (this development box is one). Every row of every table in
 *      `public`, with row counts recorded so a restore can be verified.
 *
 * The fallback is deliberately second: JSON loses sequence state and cannot
 * represent bytea well. It is a safety net, not a substitute.
 *
 *   node scripts/backup.js                 auto (pg_dump if available)
 *   node scripts/backup.js --json          force the JSON snapshot
 *   node scripts/backup.js --out <dir>     where to write (default backend/backups)
 *
 * Nothing here prints DATABASE_URL: it contains the database password.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

require("./_load-env");

const argv = process.argv.slice(2);
const FORCE_JSON = argv.includes("--json");
const outFlag = argv.indexOf("--out");
const OUT_DIR = path.resolve(
  outFlag !== -1 && argv[outFlag + 1]
    ? argv[outFlag + 1]
    : path.join(__dirname, "..", "backups")
);

function target() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see backend/.env.example).");
  const u = new URL(url);
  return {
    url,
    host: u.host,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    // Host and database only. Never the credentials.
    label: `${u.host}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`,
  };
}

function stamp() {
  // Local time is what a human reading a filename expects. Sortable.
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function findPgDump() {
  const explicit = process.env.PG_DUMP;
  if (explicit) return explicit;
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
    return "pg_dump";
  } catch {
    return null;
  }
}

function makeClient(t) {
  return new Client({
    connectionString: t.url,
    ssl: /localhost|127\.0\.0\.1/.test(t.url) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 300000,
  });
}

async function backupWithPgDump(t, bin) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${t.database}-${stamp()}.dump`);

  execFileSync(
    bin,
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${file}`,
      t.url,
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );

  const bytes = fs.statSync(file).size;
  return { file, bytes, format: "pg_dump (custom)" };
}

async function backupToJson(t) {
  const client = makeClient(t);
  await client.connect();

  try {
    const tablesRes = await client.query(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`
    );

    const tables = {};
    const counts = {};
    let rows = 0;

    for (const { table_name: name } of tablesRes.rows) {
      // Identifier quoting: names come from the catalogue, but quoting them is
      // still correct and costs nothing.
      const r = await client.query(`select * from public."${name.replace(/"/g, '""')}"`);
      tables[name] = r.rows;
      counts[name] = r.rowCount;
      rows += r.rowCount;
    }

    const server = await client.query("show server_version");

    const snapshot = {
      meta: {
        createdAt: new Date().toISOString(),
        target: t.label,
        postgres: server.rows[0].server_version,
        format: "json-snapshot-v1",
        tables: tablesRes.rowCount,
        rows,
      },
      counts,
      tables,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${t.database}-${stamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");

    return { file, bytes: fs.statSync(file).size, format: "json snapshot", tables: tablesRes.rowCount, rows };
  } finally {
    await client.end();
  }
}

async function main() {
  const t = target();
  process.stdout.write(`\nBacking up ${t.label}\n`);

  const pgDump = FORCE_JSON ? null : findPgDump();

  let result;
  if (pgDump) {
    process.stdout.write(`  using ${pgDump}\n`);
    result = await backupWithPgDump(t, pgDump);
  } else {
    if (!FORCE_JSON) {
      process.stdout.write(
        "  pg_dump not found - falling back to a JSON snapshot.\n" +
          "  (Install the PostgreSQL client and set PG_DUMP for a real dump.)\n"
      );
    }
    result = await backupToJson(t);
  }

  const mb = (result.bytes / 1024 / 1024).toFixed(2);
  process.stdout.write(`\n  ${result.format}\n`);
  process.stdout.write(`  file   ${result.file}\n`);
  process.stdout.write(`  size   ${mb} MB\n`);
  if (result.tables !== undefined) {
    process.stdout.write(`  tables ${result.tables}\n  rows   ${result.rows}\n`);
  }
  process.stdout.write(`\nRestore with:\n  node scripts/restore.js "${result.file}" --yes\n\n`);
}

main().catch((err) => {
  process.stderr.write(`\nbackup failed: ${err.message}\n`);
  process.exitCode = 1;
});
