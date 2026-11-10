# M10: Private operator pack

Goal: after sign-in, the app looks and works like the original operator's load control tool: its name, mark, colours, real forms, real limits and scanned paper forms. Before sign-in it shows only "Load Control". Neither the public repo nor the public site ever contains the operator's material.

## Decisions made with the user (2026-11-09)

- Everyone who signs in sees the operator pack. There is no per-account branding.
- The full original comes back: name, mark, colours, all six of its forms (the four here plus two more 1900D seat configurations), real limits, form versions and the scanned forms as the print backdrop.
- The sign-in screen shows "Load Control" with no mark.
- The Reports tab is hidden for now. The weekly report and its schedule keep running.
- The 504 seeded flights and the stored reports stay as they are.

## Where things live

| What | Where | Public? |
|---|---|---|
| Code that loads and applies a pack | `js/pack.js`, `js/db.js`, `js/app.js` | Yes, generic |
| Table that holds the pack | migration `operator_profile` | Yes, empty |
| Push script | `scripts/push-operator-pack.mjs` | Yes, generic, takes a file path |
| The pack itself (`profile.json`) | `../operator-pack/` next to the repo, never committed | No |
| Extract script (reads the original single file) | `../operator-pack/extract.mjs` | No |

The pack lives in the database, readable only by signed-in users, like `forms`. The site fetches it after sign-in, so nothing before sign-in can reach it.

## Database

New migration `operator_profile`:
- One row (`id = 1`, `check (id = 1)`), column `profile jsonb not null`, `updated_at`.
- RLS on. `select` for `authenticated`. No write policy, so the app can't change it. `anon` gets nothing.

`push-operator-pack.mjs <profile.json>` runs through the saved CLI login, the same way `seed/load.mjs` does:
1. Upserts the `operator_profile` row.
2. Upserts the pack's forms into `forms`, `form_zones` and `form_groups` with `formRows()` from `forms-sql.mjs`, so the database limits match the pack. This adds the two extra 1900D forms. Existing form ids stay, so the seeded flights keep their forms.
3. `--dry-run` prints the SQL sizes and form ids without writing.

## The pack (`profile.json`)

```
{
  "operator": { "name", "app", "label", "limitsNote": "" },
  "logo":     "<svg …>",                 // top bar mark
  "theme":    { "light": {css vars}, "dark": {css vars} },
  "features": { "reports": false },
  "forms":    { FORMS entries, each with "version" },
  "pos":      { overlay positions per form },
  "images":   { form id: JPEG data URL },
  "airports": [ { "code", "city" } ]      // added to the pick list
}
```

`extract.mjs` builds it from the original single file: its forms, scan positions, scanned images, mark and colour variables. The original's Dash 8 form maps to the existing id `DH8300`, keeping the original's form name.

## App

- **Before sign-in:** the top bar shows "Load Control" only. The Northbound mark moves from page load to after sign-in.
- **After sign-in:** `db.loadPack()` reads the row. `applyPack(pack)` in `js/pack.js` replaces the contents of `OPERATOR`, `FORMS` and `FORM_POS` in place, adds the airports, and returns the theme, logo, form images and features. `app.js` then sets the mark and title, adds a `<style>` with the theme variables, and hides the Reports link when `features.reports` is false. Only then does the first render run.
- **No row:** the app runs as Northbound, as it does today.
- **Forms:** when a form has a scan, `formSvg` draws the scan as an `<image>` instead of `drawForm()`. The overlay code is unchanged, because the positions in the pack are the scan's own pixel grid, which `FORM_POS` already uses. Forms without a scan are still drawn.
- **Form version and labels** come from the form's `version` and `OPERATOR.label`. The illustrative-limits note is shown only when `limitsNote` is set.
- **Sign-out** reloads the page, so nothing from the pack stays in memory.
- **reports.html:** after sign-in, if the pack hides reports, it redirects to `index.html`.
- **Pack read fails** (network or RLS): the app shows an error with a retry and doesn't render flights on the fallback forms, so a flight is never checked against the wrong limits.

## Checks

- `check-forms-sync.mjs` compares the database with the effective config: `config.js` with `../operator-pack/profile.json` applied when that file exists.
- `check-debrand.sh ../debrand-terms.txt` must still pass.

## Testing

- Unit (`js/pack.test.mjs`): applying a pack replaces forms and limits, the limit check uses the pack's limits, unknown keys are ignored, `null` leaves the Northbound defaults.
- `forms-sql.test.mjs`: rows for a pack form that isn't in `config.js` (generic test ids; the operator's form ids are debrand terms, so they never appear in the repo).
- Push script dry run, then a real push, then `check-forms-sync`.
- Browser, local preview: signed out shows "Load Control" and no request for the pack; signed in shows the operator; each of the six forms renders over its scan with the overlay in place; the over-limit print block fires on a real limit; one print preview per form; Reports link hidden and `reports.html` redirects; sign-out returns to the plain sign-in screen.

## Rollout

1. Merge the code. The live site works the same until a pack exists, apart from the sign-in screen.
2. Run the push script against production.
3. Commit and push only on the user's word.

## Out of scope

Per-account branding, the edge functions, alert emails, the stored reports and the seed data.

---

# Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the private operator pack after sign-in and apply it, with an unbranded sign-in screen and the Reports tab hidden.

**Architecture:** `js/pack.js` replaces the contents of the exported config objects in place, so every module that imported them sees the pack. `app.js` and `reports.js` fetch the pack between sign-in and the first render. The pack is one jsonb row behind RLS, uploaded by a generic script from a file outside the repo.

**Tech stack:** Plain ES modules, `node --test`, Supabase (Postgres, RLS, supabase-js), Supabase CLI.

**Rules for every task:** no operator terms in the repo (`scripts/check-debrand.sh ../debrand-terms.txt` must pass), no commits or pushes until the user says so, and `npm test` stays green.

## Files

| File | Change |
|---|---|
| `js/config.js` | `OPERATOR` gains `label`, `limitsNote`, `formVersion`; the three loose string exports go |
| `js/pack.js` | New: `applyPack`, `themeCss`, `dress` |
| `js/pack.test.mjs` | New |
| `js/brand.js` | `LOGO` uses the pack's mark when one is set |
| `js/draw.js` | Reads labels from `OPERATOR` and the form's `version` |
| `js/db.js` | `loadPack()` |
| `js/app.js` | Pack in `boot()`, form image backdrop, lazy airport set, reload on sign-out |
| `js/reports.js` | Pack after sign-in; redirect when reports are hidden |
| `index.html`, `reports.html` | "Load Control", no mark before sign-in; id on the Reports link |
| `supabase/migrations/20261109090000_operator_profile.sql` | New table |
| `supabase/tests/operator_profile_check.sql` | New RLS check |
| `scripts/forms-sql.mjs` | Header note is a parameter |
| `scripts/push-operator-pack.mjs` | New |
| `scripts/check-forms-sync.mjs` | Compares against the effective config |
| `../operator-pack/extract.mjs`, `../operator-pack/profile.json` | Outside the repo |

### Task 1: Labels move into `OPERATOR`

**Files:** `js/config.js:7-10`, `js/app.js`, `js/draw.js`

- [ ] Replace lines 7-10 of `js/config.js` with:

```js
// app: the top bar title after sign-in. label: the demo notice. limitsNote: shown when set.
export const OPERATOR = {
  name: 'Northbound Air', app: 'Load Control Lite', label: 'Demo, not for operational use',
  limitsNote: 'Illustrative limits, not from any real aircraft', formVersion: 'Demo form v1',
};
```

- [ ] `js/app.js`: drop `DEMO_LABEL, LIMITS_NOTE` from the import; `pageFoot` uses `OPERATOR.label`; line 347 becomes `${OPERATOR.limitsNote ? `<p class="hint">${esc(OPERATOR.limitsNote)}.</p>` : ''}`. Change the hint "Dash 8-300 portrait" to "Dash 8 portrait".
- [ ] `js/draw.js`: import `OPERATOR` instead of the three constants; header uses `form.version || OPERATOR.formVersion`; the two notes use `OPERATOR.limitsNote` and `OPERATOR.label`.
- [ ] Run `npm test`. Expected: 103 pass.

### Task 2: `applyPack` and `themeCss` (TDD)

**Files:** create `js/pack.js`, `js/pack.test.mjs`

- [ ] Write `js/pack.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATOR, FORMS, FORM_POS, AIRPORTS } from './config.js';
import { compute } from './load.js';
import { applyPack, themeCss } from './pack.js';

const TESTX = {
  type: 'Test', name: 'Test form', version: 'v9', layout: 'strip', orientation: 'landscape',
  zones: [{ id: 'A', label: 'A', max: 100, tail: true, w: 1 }], groups: [], loadOrder: ['A'],
};

test('no pack leaves the defaults alone', () => {
  const before = Object.keys(FORMS);
  assert.equal(applyPack(null), null);
  assert.deepEqual(Object.keys(FORMS), before);
});

test('a pack replaces forms, positions, operator and adds airports once', () => {
  const out = applyPack({
    operator: { app: 'Load Control', limitsNote: '' }, forms: { TESTX }, pos: { TESTX: { w: 10 } },
    airports: [{ code: 'ZZZ', city: 'Test' }, { code: 'YYZ', city: 'Dup' }], extra: 1,
  });
  assert.deepEqual(Object.keys(FORMS), ['TESTX']);
  assert.deepEqual(Object.keys(FORM_POS), ['TESTX']);
  assert.equal(OPERATOR.app, 'Load Control');
  assert.equal(OPERATOR.name, 'Northbound Air'); // keys the pack leaves out stay
  assert.equal(AIRPORTS.filter(a => a.code === 'ZZZ').length, 1);
  assert.equal(AIRPORTS.filter(a => a.code === 'YYZ').length, 1);
  assert.deepEqual(out.features, { reports: true });
  assert.deepEqual(out.images, {});
});

test('the limit check uses the pack limits', () => {
  const f = { form: 'TESTX', rows: [{ id: 'r', dest: 'ZZZ', cargo: '150', post: '', fast: '', bag: '' }],
    alloc: { r: { all: { A: '150' } } }, pos: {}, manual: true };
  const c = compute(f);
  assert.equal(c.zones.find(z => z.id === 'A').max, 100);
  assert.equal(c.planned.A, 150);
});

test('themeCss writes light, auto-dark and forced-dark blocks', () => {
  const css = themeCss({ light: { '--brand': '#111' }, dark: { '--brand': '#222' } }, '.x{a:b}');
  assert.match(css, /^:root \{ --brand: #111; \}/);
  assert.match(css, /prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ --brand: #222; \} \}/);
  assert.match(css, /:root\[data-theme="dark"\] \{ --brand: #222; \}/);
  assert.match(css, /\.x\{a:b\}$/);
});
```

- [ ] Run `node --test js/pack.test.mjs`. Expected: fails, `pack.js` not found.
- [ ] Write `js/pack.js`:

```js
/* Operator pack: a private operator's name, mark, colours, forms and form images.
   It lives in the operator_profile table, which only signed-in users can read, and
   replaces the Northbound defaults in place, so every module that imported them
   sees the change. No pack means Northbound. */
import { OPERATOR, FORMS, FORM_POS, AIRPORTS } from './config.js';
import { setMark } from './brand.js';

const replace = (target, src) => { Object.keys(target).forEach(k => delete target[k]); Object.assign(target, src); };

export function applyPack(pack) {
  if (!pack) return null;
  if (pack.operator) Object.assign(OPERATOR, pack.operator);
  if (pack.forms) replace(FORMS, pack.forms);
  if (pack.pos) replace(FORM_POS, pack.pos);
  const known = new Set(AIRPORTS.map(a => a.code));
  (pack.airports || []).forEach(a => { if (!known.has(a.code)) { AIRPORTS.push(a); known.add(a.code); } });
  if (pack.logo) setMark(pack.logo);
  return { theme: pack.theme || null, css: pack.css || '', images: pack.images || {}, features: { reports: true, ...pack.features } };
}

const block = vars => Object.entries(vars || {}).map(([k, v]) => `${k}: ${v};`).join(' ');
export const themeCss = (theme, extra = '') => [
  `:root { ${block(theme?.light)} }`,
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${block(theme?.dark)} } }`,
  `:root[data-theme="dark"] { ${block(theme?.dark)} }`,
  extra,
].join('\n');

// Top bar, page title and colours. Runs once, after sign-in, on both pages.
export function dress(applied) {
  const brand = document.getElementById('brand');
  brand.querySelector('.app').textContent = OPERATOR.app;
  brand.querySelector('.poc').textContent = OPERATOR.label;
  document.title = OPERATOR.app;
  if (applied) {
    const style = document.createElement('style');
    style.textContent = themeCss(applied.theme, applied.css);
    document.head.appendChild(style);
    if (!applied.features.reports) document.getElementById('reportsLink')?.remove();
  }
}
```

- [ ] `js/brand.js`: add `let mark = null; export const setMark = svg => { mark = svg; };` and make `LOGO` return `mark.replace('<svg', `<svg class="${cls}"`)` when `mark` is set.
- [ ] Add `js/pack.test.mjs` to the `test` script in `package.json`. Run `npm test`. Expected: all pass.

### Task 3: `operator_profile` table

**Files:** create `supabase/migrations/20261109090000_operator_profile.sql`, `supabase/tests/operator_profile_check.sql`

- [ ] Migration:

```sql
-- One private operator pack (name, mark, colours, forms, form images), applied by the
-- app after sign-in. Signed-in users read it; only scripts/push-operator-pack.mjs writes it.
create table public.operator_profile (
  id         int primary key default 1 check (id = 1),
  profile    jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.operator_profile enable row level security;
create policy "logged-in users read the operator profile" on public.operator_profile for select to authenticated using (true);
grant select on public.operator_profile to authenticated;
grant all    on public.operator_profile to service_role;
```

- [ ] RLS check, in the style of `supabase/tests/rls_check.sql`: as `anon`, `select count(*)` raises permission denied; as `authenticated`, an `insert` raises.
- [ ] `supabase db push </dev/null`, then run the check with `supabase db query --linked -f supabase/tests/operator_profile_check.sql </dev/null`. Expected: both checks pass.

### Task 4: `db.loadPack()` and boot

**Files:** `js/db.js`, `js/app.js`, `index.html`

- [ ] `js/db.js`:

```js
// The operator pack, or null when none is stored. Throws on a failed read, so the app
// never falls back to the default forms by accident.
export async function loadPack() {
  const { data, error } = await sb.from('operator_profile').select('profile').maybeSingle();
  if (error) throw error;
  return data?.profile ?? null;
}
```

- [ ] `index.html`: brand titles become `<span class="app">Load Control</span><span class="poc"></span>`, `<title>Load Control</title>`, Reports link gets `id="reportsLink"`.
- [ ] `js/app.js`:
  - `const AIRPORT_CODES` becomes `const airportCodes = () => new Set(AIRPORTS.map(a => a.code));` and its use sites call it.
  - Delete the module-end `LOGO` and datalist inserts. Add `let images = {}, packed = false;` and, in `boot()` after the signed-out return and inside the existing `try`, before `loadFlights()`:

```js
if (!packed) {
  const applied = applyPack(await db.loadPack());
  images = applied?.images || {};
  dress(applied);
  document.getElementById('brand').insertAdjacentHTML('afterbegin', LOGO('logo'));
  document.body.insertAdjacentHTML('beforeend', `<datalist id="airports">${AIRPORTS.map(a => `<option value="${a.code}">${esc(a.city)}</option>`).join('')}</datalist>`);
  packed = true;
}
```

  - The error card's heading becomes "Couldn't load".
  - In `formSvg`, the backdrop becomes `${images[f.form] ? `<image href="${images[f.form]}" x="0" y="0" width="${P.w}" height="${P.h}" preserveAspectRatio="none"/>` : drawForm(form, P)}`.
  - `signOut` reloads: `return db.signOut().then(() => location.reload());`
- [ ] Browser, no pack row yet: signed out shows "Load Control", no mark; signed in shows Northbound as today.

### Task 5: Reports page

**Files:** `js/reports.js`, `reports.html`

- [ ] `reports.html`: same brand title change as `index.html`.
- [ ] `js/reports.js` `boot()`: remove the first-line `LOGO` insert; after the signed-out return:

```js
const applied = applyPack(await loadPack());
if (applied && !applied.features.reports) { location.replace('index.html'); return; }
dress(applied);
$('brand').insertAdjacentHTML('afterbegin', LOGO('logo'));
```

### Task 6: Push script

**Files:** `scripts/forms-sql.mjs`, create `scripts/push-operator-pack.mjs`, `scripts/check-forms-sync.mjs`

- [ ] `formsSql(forms, note = 'Illustrative limits, not from any real aircraft.')` writes `-- ${note}` as its second header line. Existing test stays green.
- [ ] `scripts/push-operator-pack.mjs`:

```js
#!/usr/bin/env node
/* Uploads a private operator pack: the operator_profile row, plus the pack's form limits
   into forms, form_zones and form_groups. The pack file stays outside the repo.
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
```

- [ ] `check-forms-sync.mjs`: if `../operator-pack/profile.json` exists (resolved from the repo root), compare against `formRows(pack.forms)` instead of `formRows(FORMS)`, and say which one it used.

### Task 7: Build the pack (outside the repo)

**Files:** `../operator-pack/extract.mjs`, output `../operator-pack/profile.json`

The extract script reads `../Load-Control-Lite-Branded.html` and writes `profile.json`. It is never committed, because it names the operator's identifiers.

- [ ] Pull out the original's forms, scan positions and form images by evaluating their object literals (the file is the user's own). Rename the original Dash 8 form id to `DH8300` in all three. Mark the 12-seat combi's row zones `seat: true`, as `config.js` does.
- [ ] `operator`: `{ name: <operator name>, app: 'Load Control', label: 'Proof of concept', limitsNote: '' }`.
- [ ] `logo`: the original's top-bar mark. `css`: the original's print rules that colour the wordmark and size `.plogo`.
- [ ] `theme`: the original's light and dark variables, plus `--brand` (navy), `--brand-2` (red) and `--print-ink` (navy).
- [ ] `airports` from `airports.json`; `features: { reports: false }`.
- [ ] Check: six forms, ids include `PC12`, `B1900D19`, `B1900D12`, `DH8300`; every form has positions and an image; JSON parses.

### Task 8: Push and verify

- [ ] `node scripts/push-operator-pack.mjs ../operator-pack/profile.json --dry-run`. Expected: six form ids, about 1.3 MB.
- [ ] Push for real, then `node scripts/check-forms-sync.mjs`. Expected: match, using the pack.
- [ ] `npm test` and `scripts/check-debrand.sh ../debrand-terms.txt`. Expected: pass.
- [ ] Browser at `http://127.0.0.1:8411` (user): the sign-in checks listed under Testing above.
- [ ] Hand back to the user for commit and push.

## Changes after review (2026-11-09)

- **Shared palette.** The user decided colours alone may be public. The navy, red and yellow palette is now the base palette in `css/app.css`, so the sign-in screen uses it too; the destination tags and drag highlight are yellow again. The colour codes came off the debrand term list. The mark, name and forms stay in the private pack.
- **Placement stays in step with the manifest after hand edits.** `balanceRow` and `syncRow` in `js/load.js` replace the all-or-nothing switch:
  - A number typed in a placement cell comes out of, or goes back to, that stop's largest other section. It never moves to a section the stop doesn't already use.
  - A manifest change updates only the stop that changed: a new stop is placed in load order where there's room, a heavier stop grows in its largest section, and a lighter stop shrinks its smallest sections first.
  - Automatic changes never go past a limit; the rest shows as Difference.
  - Dash 8 Bags and Cargo balance separately.
  - Before the first hand edit, auto-place still re-runs for the whole flight.
