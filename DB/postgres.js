require("dotenv").config();
const { Pool } = require("pg");

// On Cloud Run (with --add-cloudsql-instances set and the Cloud SQL
// Client IAM role granted to its service account), Cloud Run mounts the
// instance's Unix socket at /cloudsql/INSTANCE_CONNECTION_NAME — no
// public IP, no Authorized Networks allowlist, traffic never leaves
// Google's network. Set INSTANCE_CONNECTION_NAME only in the Cloud Run
// env vars, never locally.
//
// Locally (no INSTANCE_CONNECTION_NAME set), we fall back to DB_HOST —
// either the Cloud SQL public IP directly (needs your current IP in
// Authorized Networks + SSL) or 127.0.0.1 via a local Cloud SQL Auth
// Proxy (no SSL, since the proxy already encrypts its own tunnel).
const isLocalHost = ["localhost", "127.0.0.1"].includes(process.env.DB_HOST);

const pool = process.env.INSTANCE_CONNECTION_NAME
  ? new Pool({
      host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    })
  : new Pool({
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: process.env.DB_PORT,
      ssl: isLocalHost ? false : { rejectUnauthorized: false },
    });

module.exports = pool;
