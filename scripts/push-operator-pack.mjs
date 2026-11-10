#!/usr/bin/env node
/* Uploads a private operator pack: the operator_profile row, plus the pack's form limits
   into forms, form_zones and form_groups, in one transaction. The pack file stays
   outside the repo. Uses the saved CLI login; never needs the database password.
   Usage: node scripts/push-operator-pack.mjs ../operator-pack/profile.json [--dry-run] */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { formsSql } from './forms-sql.mjs';
import { runFile } from './db-query.mjs';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('usage: push-operator-pack.mjs <profile.json> [--dry-run]'); process.exit(2); }
const text = readFileSync(file, 'utf8');
const pack = JSON.parse(text);
// a dollar-quote tag the JSON can't contain
const tag = '$p' + randomBytes(6).toString('hex') + '$';
const sql = `begin;
insert into public.operator_profile (id, profile) values (1, ${tag}${text}${tag}::jsonb)
on conflict (id) do update set profile = excluded.profile, updated_at = now();
${formsSql(pack.forms, 'Operator pack limits.')}
commit;
`;
console.log(`forms: ${Object.keys(pack.forms).join(', ')} · ${(sql.length / 1e6).toFixed(2)} MB of SQL`);
if (flag === '--dry-run') process.exit(0);
const dir = mkdtempSync(join(tmpdir(), 'pack-'));
try { writeFileSync(join(dir, 'pack.sql'), sql); runFile(join(dir, 'pack.sql')); }
finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Operator pack pushed.');
