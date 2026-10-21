#!/usr/bin/env node
"use strict";

/**
 * Database restore.
 *
 * The other half of `backup.js`. A backup that has never been restored is a
 * guess, so this exists to make the drill possible.
 *
 *   node scripts/restore.js <file.json|file.dump> --yes
 *
 * ## This is destructive
 *
 * A JSON restore truncates every table present in the snapshot and refills it.
 * It requires `--yes`, and it prints what it is about to overwrite first. There
 * is no undo beyond the backup you are holding.
 *
 * ## Why the JSON path disables FK triggers
 *
 * Rows are inserted with `session_replication_role = replica`, which suspends
 * FK and user triggers for the transaction. Without that, a restore has to
 * insert parents before children, which means hardcoding a dependency order
 * that goes stale the moment a table is added. The trade-off is that the
 * snapshot is trusted as a whole - it came from the same database, so it is
 * internally consistent by construction.
 *
 * Sequences are re-synced afterwards, because truncation with `restart
 * identity` resets them and the restored rows carry explicit ids.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

require("./_load-env");

const argv = process.argv.slice(2);
const CONFIRMED = argv.includes("--yes");
const file = argv.find((a) => !a.startsWith("--"));

const BATCH = 500;

function target() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see backend/.env.example).");
  const u = new URL(url);
  return {
    url,
    label: `${u.host}${u.pathname}`,
  };
}

function findPgRestore() {
  const explicit = process.env.PG_RESTORE;
  if (explicit) return explicit;
  try {
    execFileSync("pg_restore", ["--version"], { stdio: "ignore" });
    return "pg_restore";
  } catch {
    return null;
  }
}

async function restoreDump(t, bin) {
  process.stdout.write(`Restoring a pg_dump archive into ${t.label}\n`);
  execFileSync(
    bin,
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", t.url, file],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  process.stdout.write("restore complete\n");
}

async function restoreJson(t, snapshot) {
  if (!snapshot?.meta || !snapshot?.tables) {
    throw new Error("This does not look like a snapshot written by scripts/backup.js.");
  }

  const names = Object.keys(snapshot.tables);
  if (names.length === 0) throw new Error("Snapshot contains no tables.");

  const client = new Client({
    connectionString: t.url,
    ssl: /localhost|127\.0\.0\.1/.test(t.url) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
    statement_timeout: 600000,
  });

  await client.connect();
  try {
    const quoted = names.map((n) => `public."${n.replace(/"/g, '""')}"`);

    process.stdout.write(`Snapshot from ${snapshot.meta.createdAt} (${snapshot.meta.target})\n`);
    process.stdout.write(`  ${names.length} tables, ${snapshot.meta.rows} rows\n`);
    process.stdout.write(`  target ${t.label}\n\n`);

    await client.query("begin");

    // Suspend FK + user triggers for this transaction only. See the header.
    await client.query("set local session_replication_role = replica");

    await client.query(`truncate table ${quoted.join(", ")} restart identity cascade`);

    let restored = 0;
    for (const name of names) {
      const rows = snapshot.tables[name];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      // jsonb_populate_recordset casts through the table's own composite type,
      // so column types, defaults and nullability are the database's problem,
      // not ours. `select *` returns the composite in table order, which is
      // what `insert into ... select *` expects.
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        await client.query(
          `insert into public."${name.replace(/"/g, '""')}"
           select * from jsonb_populate_recordset(null::public."${name.replace(/"/g, '""')}", $1::jsonb)`,
          [JSON.stringify(chunk)]
        );
      }
      restored += rows.length;
      process.stdout.write(`  ${name.padEnd(24)} ${String(rows.length).padStart(6)} rows\n`);
    }

    // Re-point every sequence at max(column). Truncation reset them to 1, and
    // the rows just inserted carry explicit ids, so the next insert would
    // collide without this.
    const seqs = await client.query(`
      select c.relname as tbl, a.attname as col,
             pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) as seq
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public' and c.relkind = 'r'
         and pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) is not null
    `);

    for (const { tbl, col, seq } of seqs.rows) {
      if (!seq) continue;
      await client.query(
        `select setval($1,
           coalesce((select max("${col.replace(/"/g, '""')}") from public."${tbl.replace(/"/g, '""')}"), 0) + 1,
           false)`,
        [seq]
      );
    }

    await client.query("commit");

    // Verify rather than assume: compare row counts to the snapshot.
    let mismatches = 0;
    for (const name of names) {
      const r = await client.query(`select count(*)::int as n from public."${name.replace(/"/g, '""')}"`);
      if (r.rows[0].n !== snapshot.tables[name].length) {
        mismatches++;
        process.stderr.write(
          `  MISMATCH ${name}: snapshot ${snapshot.tables[name].length}, restored ${r.rows[0].n}\n`
        );
      }
    }

    process.stdout.write(
      `\nrestored ${restored} rows across ${names.length} tables` +
        (mismatches ? ` - ${mismatches} MISMATCH(ES)` : " - counts verified") +
        "\n"
    );
    if (mismatches) process.exitCode = 1;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

async function main() {
  if (!file) {
    process.stdout.write("Usage: node scripts/restore.js <file.json|file.dump> --yes\n");
    process.exitCode = 1;
    return;
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`No such file: ${resolved}`);

  const t = target();
  const isDump = /\.dump$/.test(resolved);

  if (!CONFIRMED) {
    process.stdout.write(
      `\n!! This REPLACES the data in ${t.label} with the contents of\n   ${resolved}\n\n` +
        `Re-run with --yes if that is what you want.\n\n`
    );
    process.exitCode = 1;
    return;
  }

  if (isDump) {
    const bin = findPgRestore();
    if (!bin) {
      throw new Error(
        "pg_restore is not on PATH. Install the PostgreSQL client, or use a JSON snapshot."
      );
    }
    await restoreDump(t, bin);
    return;
  }

  const snapshot = JSON.parse(fs.readFileSync(resolved, "utf8"));
  await restoreJson(t, snapshot);
}

main().catch((err) => {
  process.stderr.write(`\nrestore failed: ${err.message}\n`);
  process.exitCode = 1;
});
