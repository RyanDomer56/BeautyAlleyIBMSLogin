/**
 * Loads environment variables for the standalone scripts.
 *
 * Order matters: `backend/.env.local` (the real credentials, gitignored) is
 * read first and wins; `backend/.env` (tracked, placeholders only) fills in
 * anything the local file does not define. dotenv keeps the first value it
 * sees for a key, so .env.local always overrides .env.
 *
 * Anchored on __dirname rather than process.cwd(), so a script behaves the
 * same whether it is run from backend/ or from the repository root.
 *
 * A missing .env.local is not an error - a fresh clone has only .env.
 */
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: [
    path.join(__dirname, "..", ".env.local"),
    path.join(__dirname, "..", ".env"),
  ],
});

module.exports = process.env;
