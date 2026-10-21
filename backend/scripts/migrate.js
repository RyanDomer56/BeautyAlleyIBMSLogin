#!/usr/bin/env node
"use strict";

/**
 * Migration runner.
 *
 * The Supabase CLI cannot be used here: `supabase start` needs Docker, and
 * `supabase db push` needs a Docker-backed local stack too. This script talks
 * to Postgres directly over the wire instead, which is why it only needs
 * DATABASE_URL.
 *
 *   node scripts/migrate.js            apply pending migrations
 *   node scripts/migrate.js --status   show what is applied / pending
 *   node scripts/migrate.js --dry-run  validate and list what WOULD apply
 *   node scripts/migrate.js --reset --yes
 *                                      DROP schema public and reapply everything
 *
 * Each file runs inside its own transaction: a migration either fully applies
 * or leaves no trace. The ledger records a checksum, so editing a migration
 * that has already been applied is detected rather than silently ignored.
 *
 * Rollback is forward-only by design. There are no `.down.sql` files, because a
 * down-migration that has never been run is a guess. The recovery path for a
 * bad migration is: restore the most recent backup, then fix forward. That is
 * only a real answer if backups exist - see `docs/runbook.md`.
 *
 * A session advisory lock prevents two runners from interleaving.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

require("./_load-env");

const MIGRATIONS_DIR = path.join(__dirname, "..", "supabase", "migrations");

// The ledger lives in its own schema, not in `public`. PostgREST exposes
// `public` to the internet, so anything parked there needs RLS or it is
// world-readable. Infrastructure bookkeeping does not belong in the API
// surface at all - this mirrors what the official Supabase CLI does.
const LEDGER_SCHEMA = "supabase_migrations";
const LEDGER = `${LEDGER_SCHEMA}.schema_migrations`;

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const argv = process.argv.slice(2);
const MODE = argv.includes("--reset")
  ? "reset"
  : argv.includes("--status")
    ? "status"
    : argv.includes("--dry-run") || argv.includes("--plan")
      ? "plan"
      : "migrate";
const CONFIRMED = argv.includes("--yes");

/**
 * Advisory lock, so two runners cannot interleave.
 *
 * Without it, two `db:migrate` processes (a CI job and a human, say) both read
 * the ledger, both see migration N as pending, and both apply it. The second
 * fails on a duplicate object halfway through, leaving the ledger and the
 * schema disagreeing about what exists. The lock is session-scoped and released
 * automatically if the process dies.
 *
 * The key is arbitrary but must never change, or old and new runners would not
 * see each other's lock.
 */
const LOCK_KEY = 8710035;

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      return {
        file,
        version: file.split("_")[0],
        sql,
        checksum: crypto
          .createHash("sha256")
          // Hash the LF form, never the raw bytes. Git checks these files out
          // with CRLF on Windows (core.autocrlf), and hashing the raw content
          // would make every already-applied migration look "changed" - which
          // blocks the runner from applying anything new, permanently.
          .update(sql.replace(/\r\n/g, "\n"))
          .digest("hex")
          .slice(0, 16),
        bytes: Buffer.byteLength(sql),
      };
    });
}

function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in."
    );
  }
  return new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 120000,
  });
}

async function ensureLedger(client) {
  await client.query(`create schema if not exists ${LEDGER_SCHEMA}`);
  await client.query(`
    create table if not exists ${LEDGER} (
      version     text primary key,
      name        text not null,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    )
  `);
}

async function fetchApplied(client) {
  const r = await client.query(`select version, name, checksum, applied_at from ${LEDGER}`);
  const map = new Map();
  for (const row of r.rows) map.set(row.version, row);
  return map;
}

async function resetSchema(client) {
  process.stdout.write(`${c.yellow}${c.bold}!! DROPPING schema public CASCADE${c.reset}\n`);
  await client.query("drop schema if exists public cascade");
  await client.query(`drop schema if exists ${LEDGER_SCHEMA} cascade`);
  await client.query("create schema public");
  await client.query("alter schema public owner to postgres");
  await client.query(
    "grant all on schema public to postgres, anon, authenticated, service_role"
  );
  process.stdout.write(`${c.green}schema public recreated${c.reset}\n\n`);
}

async function applyOne(client, mig) {
  const started = Date.now();
  await client.query("begin");
  try {
    await client.query(mig.sql);
    await client.query(
      `insert into ${LEDGER} (version, name, checksum, duration_ms)
       values ($1, $2, $3, $4)`,
      [mig.version, mig.file, mig.checksum, Date.now() - started]
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return Date.now() - started;
}

async function main() {
  const migrations = listMigrations();
  const client = makeClient();

  if (MODE === "reset" && !CONFIRMED) {
    process.stdout.write(
      `${c.red}--reset drops every object in schema public, including all data.${c.reset}\n` +
        `Re-run with ${c.bold}--reset --yes${c.reset} if that is genuinely what you want.\n`
    );
    return;
  }

  await client.connect();

  const server = await client.query("show server_version");
  process.stdout.write(
    `${c.dim}connected - postgres ${server.rows[0].server_version}${c.reset}\n\n`
  );

  if (MODE === "reset") {
    await resetSchema(client);
  }

  await ensureLedger(client);
  const applied = await fetchApplied(client);

  // --- status -------------------------------------------------------------
  if (MODE === "status") {
    process.stdout.write(`${c.bold}Migration status${c.reset}\n`);
    let pending = 0;
    for (const m of migrations) {
      const row = applied.get(m.version);
      if (!row) {
        pending++;
        process.stdout.write(`  ${c.yellow}PENDING${c.reset}  ${m.file}\n`);
      } else if (row.checksum !== m.checksum) {
        process.stdout.write(
          `  ${c.red}CHANGED${c.reset}  ${m.file}  ${c.dim}(applied ${row.applied_at.toISOString()})${c.reset}\n`
        );
      } else {
        process.stdout.write(`  ${c.green}APPLIED${c.reset}  ${m.file}\n`);
      }
    }
    process.stdout.write(
      `\n${applied.size} applied, ${pending} pending, ${migrations.length} total\n`
    );
    await client.end();
    return;
  }

  // --- plan ---------------------------------------------------------------
  // What `--dry-run` means here: validate everything a real run would validate
  // (checksums, ordering) and list the files it would execute, without touching
  // the schema. It is not a SQL-level dry run - Postgres cannot roll back DDL
  // that was never run - so it answers "is it safe to press the button", not
  // "will every statement succeed".
  if (MODE === "plan") {
    const pending = [];
    for (const m of migrations) {
      const row = applied.get(m.version);
      if (row) {
        if (row.checksum !== m.checksum) {
          await client.end();
          throw new Error(
            `${m.file} has changed since it was applied ` +
              `(ledger ${row.checksum}, file ${m.checksum}).\n` +
              `A real run would refuse to proceed. Add a new migration instead.`
          );
        }
        continue;
      }
      pending.push(m);
    }

    process.stdout.write(`${c.bold}Dry run - nothing will be applied${c.reset}\n`);
    if (pending.length === 0) {
      process.stdout.write(`  ${c.green}no pending migrations${c.reset}\n`);
    } else {
      for (const m of pending) {
        process.stdout.write(
          `  ${c.yellow}would apply${c.reset}  ${m.file}  ${c.dim}${m.bytes} bytes${c.reset}\n`
        );
      }
    }
    process.stdout.write(
      `\n${pending.length} pending, ${applied.size} already applied, ${migrations.length} total\n`
    );
    await client.end();
    return;
  }

  // --- migrate ------------------------------------------------------------
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);

  let count = 0;
  let failure = null;
  try {
    for (const m of migrations) {
      const row = applied.get(m.version);

      if (row) {
        if (row.checksum !== m.checksum) {
          throw new Error(
            `${m.file} has changed since it was applied ` +
              `(ledger ${row.checksum}, file ${m.checksum}).\n` +
              `Migrations are immutable once applied. Add a new migration instead, ` +
              `or run --reset --yes to rebuild from scratch.`
          );
        }
        continue;
      }

      process.stdout.write(`  ${c.cyan}applying${c.reset} ${m.file} ... `);
      try {
        const ms = await applyOne(client, m);
        process.stdout.write(`${c.green}ok${c.reset} ${c.dim}${ms}ms${c.reset}\n`);
        count++;
      } catch (err) {
        process.stdout.write(`${c.red}FAILED${c.reset}\n\n`);
        process.stdout.write(`${c.red}${err.message}${c.reset}\n`);
        if (err.detail) process.stdout.write(`${c.dim}${err.detail}${c.reset}\n`);
        if (err.hint) process.stdout.write(`${c.dim}hint: ${err.hint}${c.reset}\n`);
        if (err.position) {
          const upto = m.sql.slice(0, Number(err.position));
          const line = upto.split("\n").length;
          process.stdout.write(`${c.dim}at line ${line} of ${m.file}${c.reset}\n`);
        }
        failure = err;
        break;
      }
    }
  } finally {
    // Released before the client closes. If the process died instead, Postgres
    // drops the session and the lock with it.
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
  }

  if (failure) {
    await client.end();
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    count === 0
      ? `\n${c.green}Database is up to date.${c.reset} Nothing to apply.\n`
      : `\n${c.green}Applied ${count} migration(s).${c.reset}\n`
  );

  await client.end();
}

main().catch((err) => {
  process.stdout.write(`\n${c.red}${err.message}${c.reset}\n`);
  process.exitCode = 1;
});
