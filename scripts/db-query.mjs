/* Runs SQL against the linked Supabase project through the CLI and returns the rows.
   Uses the saved CLI login; never needs the database password. */
import { execFileSync } from 'node:child_process';

// On a SQL error the CLI prints {"_tag":"Error",...} on stdout and exits 1, so the
// real message is in the thrown error's stdout, not stderr.
function cli(args) {
  try {
    return execFileSync('supabase', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    let msg = e.stdout || e.message;
    try { msg = JSON.parse(e.stdout).error?.message || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
}

export function query(sql) {
  return JSON.parse(cli(['db', 'query', '--linked', '--output-format', 'json', sql])).rows; // numerics arrive as strings
}

export const runFile = file => cli(['db', 'query', '--linked', '-f', file]);
