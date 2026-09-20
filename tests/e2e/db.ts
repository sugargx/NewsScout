import { execFileSync } from "node:child_process";

export function databaseQuery(query: string): string {
  const psql = process.env.SCOUTNEWS_E2E_PSQL;
  const connection = process.env.SCOUTNEWS_E2E_DATABASE_URL;
  if (!psql || !connection) throw new Error("Use the isolated live E2E launcher for database assertions.");
  const url = new URL(connection);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/scoutnews_e2e_[a-f0-9]{32}$/.test(url.pathname)) {
    throw new Error("Refusing to access a non-E2E database.");
  }
  return execFileSync(psql, ["-X", "-w", "-h", url.hostname, "-p", url.port,
    "-U", decodeURIComponent(url.username), "-d", decodeURIComponent(url.pathname.slice(1)),
    "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8", input: `${query}\n;`,
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  }).trim();
}
