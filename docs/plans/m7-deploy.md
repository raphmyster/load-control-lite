# M7: Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app is live at `https://loadcontrol.raphaelattar.com`, served by GitHub Pages from the public repo `raphmyster/load-control-lite`. The edge function accepts browser calls from that origin, and a signed-in user can generate a report from the live site.

**Architecture:** No app code changes. The repo root is already a static site (`index.html`, `reports.html`, `css/`, `js/`) with relative asset paths, so Pages serves `main` from `/` as it is. A `CNAME` file names the custom domain, and `.nojekyll` makes Pages serve files as they are instead of running Jekyll. Cloudflare, which hosts DNS for raphaelattar.com, gets a DNS-only CNAME from `loadcontrol` to `raphmyster.github.io`. On Supabase, the function's `ALLOWED_ORIGINS` setting gains the live origin.

**Tech Stack:** GitHub Pages (branch deploy), Cloudflare DNS, Supabase Edge Function settings, gitleaks for the pre-push scan.

**Decisions made with the user:**
- GitHub account `raphmyster`. The user controls DNS for raphaelattar.com.
- Domain `loadcontrol.raphaelattar.com` (PRD section 13).

**Found while planning (checked on 2026-10-27):**
- `gh` is not installed. SSH to GitHub already works as `raphmyster`, so pushes go over SSH and the user does the few web-UI steps (create the repo, Pages settings, security settings). That avoids installing `gh` and an interactive `gh auth login`.
- raphaelattar.com's nameservers are Cloudflare's. The apex and `www` already point at GitHub Pages (`www` is a CNAME to `raphmyster.github.io`).
- A proxied Cloudflare wildcard answers every unlisted subdomain, `loadcontrol` included: it resolves to `172.64.80.1` and redirects (302) to `raphaelattar-com.l.ink`. An explicit DNS-only record takes precedence over the wildcard and skips that redirect. There is no CAA record, so nothing blocks the Let's Encrypt certificate GitHub requests.
- No `_github-pages-challenge-raphmyster` TXT record exists, so the domain isn't verified on the GitHub account yet.
- `scripts/check-debrand.sh ../debrand-terms.txt` passes, but its term list doesn't include the airline's bare name, and three tracked plan files still use it: "No [airline] branding" once each in m2, m4 and m5, and the parent folder's name inside an absolute path twice in m2. The same lines are in git history (5 hits). Task 1 has the user decide on this before anything is public. This plan avoids the name so it doesn't add to the count.
- History is 10 commits on one branch, with no deleted files and no `sk-or-` or JWT strings. The cron secret is generated inside the database and never written as a literal.
- Every commit's author email is `your personal Gmail address`. It becomes public with the repo.
- Sign-in is email and password (`signInWithPassword` in `js/db.js`). No magic link or OAuth flow redirects back to the site, so Auth's URL settings only matter for emails Supabase might send, such as a password reset.

**Decided while planning (reviewed by a subagent):**
- **Public repo.** Pages on a free account needs one, and a public repo gets secret scanning and push protection for free. The interviewer can also read the code.
- **Serve the repo root, not a build folder.** There is no build step. `docs/`, `seed/`, `scripts/` and `supabase/` are served too, but they are public in the repo anyway, and nothing in them is secret. Moving the site into a subfolder would touch every path for no gain.
- **`ALLOWED_ORIGINS` = live origin first, then the two preview origins.** The live origin goes first because `corsHeaders` in `index.ts` answers an unknown origin with `allowed[0]`. The preview origins stay so the local preview still works as Thursday's backup if the live site fails. That is a deliberate exception to PRD section 9's "CORS restricted to the app's domain": only a page served on the visitor's own machine could use them, and every call still needs a valid JWT or the cron secret. They come out after the interview.
- **Auth URL settings change in the dashboard, never with `supabase config push`.** The local `config.toml` has `enable_signup = true` and `site_url = "http://127.0.0.1:3000"`. Pushing it would turn sign-ups back on in production.
- **gitleaks reads git history only (`gitleaks git`), never the folder (`gitleaks dir`).** A folder scan would open the git-ignored `supabase/.env.local`, which Claude never reads, and would report the real key in it. History is what gets published. Push protection checks the push again on GitHub's side. Known non-secrets: the Supabase URL and the publishable key in `js/supabase-config.js`, both public by design.
- **Verify the domain on GitHub before pointing DNS at it.** GitHub's docs warn that a CNAME pointing at Pages before the domain is claimed lets any account claim the subdomain in the gap. Verifying raphaelattar.com on the account closes that for every subdomain, now and later.

**Who does what:** Claude writes `CNAME` and `.nojekyll`, runs the checks, adds the remote and pushes after the user says yes, sets `ALLOWED_ORIGINS`, and checks the live site with curl and the browser pane. The user creates the repo, edits Cloudflare DNS, changes the GitHub and Supabase dashboard settings, signs in on the live site, and says when to commit and push.

**Constraints:**
- The OpenRouter key exists only as an edge function secret and in the git-ignored `supabase/.env.local`. Claude never reads that file, and no tool Claude runs reads the working folder.
- Every `supabase` command Claude runs ends in `</dev/null`.
- Commit and push only on the user's word. A push to a public repo can't be taken back.
- No operator branding in the app: `scripts/check-debrand.sh ../debrand-terms.txt` must pass.
- One live report run in Task 8, Claude-only on Haiku (about $0.002, counting toward the 5-a-day cap). Any further runs need the user's OK.

---

### Task 1: Pre-publication decisions and cleanup

**Files:** depending on the user's choices, `docs/plans/m2-db.md`, `m4-report.md`, `m5-hybrid.md`, and `../debrand-terms.txt` (outside the repo)

- [ ] **Step 1: User confirms consent.** The friend whose app this is based on has agreed to the concept being shown publicly (open question from the handoff). If not, stop here: the deploy waits.

- [ ] **Step 2: User decides on the airline's name in the plan docs.** Show the user `git grep -n -i` output for the bare name and ask which option to take:
  - (a) Recommended: reword the lines in the working tree ("No original-operator branding", and the path written relative as `../.claude/launch.json`), and leave history alone. Old commits keep the 5 hits, which only someone reading old diffs would see.
  - (b) Reword them and rewrite history with `git filter-repo`, so no commit has them. Every commit hash changes, including the ones recorded in the M5 notes. If the user also wants the email private (Task 4 Step 2), do both rewrites in this one pass.
  - (c) Leave them. The interview makes the project's purpose plain anyway.

- [ ] **Step 3: For (a) or (b), make it a standing check.** The user adds the bare name as a new line in `../debrand-terms.txt` (outside the repo, so the term never enters it). From then on `check-debrand.sh` catches it.

- [ ] **Step 4: Apply the choice** and re-run the check.

Run: `scripts/check-debrand.sh ../debrand-terms.txt`
Expected: `PASS: no operator terms, no large embedded files`. Under (c), skip Step 3 and expect the same PASS as before.

- [ ] **Step 5: Confirm nothing ignored is tracked.**

Run: `git ls-files | grep -E '(^|/)\.env($|\.)|\.env\.local|node_modules|\.DS_Store'`
Expected: only `.env.example`. Any other line is a stop.

- [ ] **Step 6: Tests still pass.** Run: `npm test` → expected 90 pass, 0 fail.

- [ ] **Step 7: Install gitleaks.** Run: `brew install gitleaks`

### Task 2: Pages files

**Files:**
- Create: `CNAME`
- Create: `.nojekyll`

- [ ] **Step 1: Write `CNAME`** with exactly one line, `loadcontrol.raphaelattar.com`, and no scheme or trailing slash.

- [ ] **Step 2: Write `.nojekyll`** as an empty file.

- [ ] **Step 3: Check them.**

Run: `cat CNAME; wc -c .nojekyll`
Expected: `loadcontrol.raphaelattar.com`, then `0 .nojekyll`.

- [ ] **Step 4: Commit on the user's word**, together with the Task 1 edits and this plan.

```bash
git add CNAME .nojekyll docs/plans/
git commit -m "M7: GitHub Pages files for loadcontrol.raphaelattar.com"
```

### Task 3: Domain verification and DNS (user, in GitHub and Cloudflare)

- [ ] **Step 1: User verifies the domain on GitHub.** GitHub → Settings (account, not repo) → Pages → Add a domain → `raphaelattar.com`. GitHub shows a TXT record named `_github-pages-challenge-raphmyster` with a value.

- [ ] **Step 2: User adds that TXT record** in Cloudflare → raphaelattar.com → DNS → Records, then clicks Verify on GitHub.

Claude checks: `dig +short TXT _github-pages-challenge-raphmyster.raphaelattar.com`
Expected: the value GitHub showed, in quotes. GitHub then lists raphaelattar.com as verified.

- [ ] **Step 3: User adds the CNAME:** Type `CNAME`, Name `loadcontrol`, Target `raphmyster.github.io`, Proxy status **DNS only** (grey cloud), TTL Auto. Leave the wildcard alone; the explicit record wins over it. A proxied record would hide the CNAME from GitHub, and the HTTPS certificate would never be issued.

- [ ] **Step 4: Claude checks it.**

Run: `dig +short CNAME loadcontrol.raphaelattar.com; dig +short A loadcontrol.raphaelattar.com`
Expected: `raphmyster.github.io.`; then `raphmyster.github.io.` again followed by the four `185.199.108–111.153` addresses. If `172.64.80.1` still shows, the record is proxied or hasn't spread yet; wait a minute and check again.

### Task 4: Repo and first push

- [ ] **Step 1: User creates the repo** at github.com/new: owner `raphmyster`, name `load-control-lite`, Public, with **no** README, .gitignore or license, so the first push doesn't conflict.

- [ ] **Step 2: User decides on the commit email.** All commits carry `your personal Gmail address`, which becomes public. If GitHub → Settings → Emails has "Block command line pushes that expose my email" on, the push fails with GH007. The user either accepts the exposure (and turns that setting off if it's on), or wants privacy. Privacy means rewriting the author email to the account's `@users.noreply.github.com` address with `git filter-repo --mailmap` and setting `git config user.email` to it for future commits. That rewrite changes every hash, like option (b) in Task 1.

- [ ] **Step 3: User checks security settings.** Repo → Settings → Advanced Security (or "Code security"): **Secret Protection** on, **Push protection** on. Public repos usually have both on by default. The user confirms what they see.

- [ ] **Step 4: User confirms the OpenRouter key's credit limit** (PRD section 9: the key's own limit, set below the remaining balance, is the second safety net behind the $2.00 spend cap). OpenRouter → Keys → this app's key → Credit limit.

- [ ] **Step 5: Final checks on exactly what will be published.** Run after the last commit:

```bash
git status --short
scripts/check-debrand.sh ../debrand-terms.txt
gitleaks git --redact -v .
```
Expected: no `git status` output (everything committed), `PASS`, and gitleaks reporting no leaks, or only the publishable key (`sb_publishable_...` in `js/supabase-config.js`). Anything else is a stop: report it to the user before going further. `--redact` keeps any real secret out of the output and this chat.

- [ ] **Step 6: Claude adds the remote.**

Run: `git remote add origin git@github.com:raphmyster/load-control-lite.git && git remote -v`
Expected: `origin` for fetch and push.

- [ ] **Step 7: Ask the user before pushing.** Tell them the commit count (`git rev-list --count main`) and that the whole history becomes public. Push only on a clear yes.

Run: `git push -u origin main`
Expected: `branch 'main' set up to track 'origin/main'`. If push protection or GH007 blocks it, nothing was published. Report the message (redacted) to the user and stop.

### Task 5: GitHub Pages (user in the UI, Claude checks)

- [ ] **Step 1: User turns Pages on.** Repo → Settings → Pages → Build and deployment → Source **Deploy from a branch**, Branch `main`, folder `/ (root)`, Save.

- [ ] **Step 2: User checks the custom domain.** The Custom domain field should read `loadcontrol.raphaelattar.com`, taken from the `CNAME` file. If it's empty, they type it and Save. Wait for "DNS check successful".

- [ ] **Step 3: Claude waits for the first deploy.**

Run: `curl -sI http://loadcontrol.raphaelattar.com/ | head -5`
Expected: `HTTP/1.1 200 OK` or a `301` to https, with `server: GitHub.com`. A 404 with "There isn't a GitHub Pages site here" means the deploy hasn't finished; the repo's Actions tab shows `pages build and deployment`.

- [ ] **Step 4: User turns on Enforce HTTPS** once the certificate is ready. The checkbox stays grey until then, which can take up to an hour.

- [ ] **Step 5: Claude checks HTTPS and the assets.**

Run:
```bash
curl -sI https://loadcontrol.raphaelattar.com/ | head -1
curl -sI http://loadcontrol.raphaelattar.com/ | grep -i '^location'
for p in reports.html css/app.css js/app.js js/reports.js js/supabase-config.js; do printf '%s ' $p; curl -so /dev/null -w '%{http_code}\n' https://loadcontrol.raphaelattar.com/$p; done
```
Expected: `HTTP/2 200`, then `location: https://loadcontrol.raphaelattar.com/`, then `200` for each path.

### Task 6: Function settings

**Files:** none (function settings)

- [ ] **Step 1: List the function's secrets** (names and digests only, never values).

Run: `supabase secrets list </dev/null`
Expected: `OPENROUTER_API_KEY` present, plus Supabase's built-ins. Note whether `ALLOWED_ORIGINS` is already listed; if it isn't, the function uses the preview-origins default.

- [ ] **Step 2: Set the origins.**

Run: `supabase secrets set ALLOWED_ORIGINS=https://loadcontrol.raphaelattar.com,http://localhost:8411,http://127.0.0.1:8411 </dev/null`
Expected: `Finished supabase secrets update.` New settings reach the function without a redeploy.

- [ ] **Step 3: Check the live origin, an unknown origin, and an unsigned call.**

Run:
```bash
F=https://zjafthfktjfncwhycxej.supabase.co/functions/v1/generate-report
curl -s -i -X OPTIONS -H 'Origin: https://loadcontrol.raphaelattar.com' $F | grep -i 'access-control-allow-origin'
curl -s -i -X OPTIONS -H 'Origin: https://evil.example' $F | grep -i 'access-control-allow-origin'
curl -s -X POST -H 'Origin: https://loadcontrol.raphaelattar.com' -H 'Content-Type: application/json' -d '{}' $F
```
Expected: the live origin echoed back; the live origin again for `evil.example` (not `evil.example`); then `{"error":"Sign in first."}`, which comes from the function's own code since `verify_jwt = false`. If the first line still shows localhost after a minute, run Step 1 again to confirm the name.

### Task 7: Supabase Auth (user, in the dashboard)

- [ ] **Step 1: User confirms sign-ups are still off.** Authentication → Sign In / Providers → "Allow new users to sign up" is off. Nothing in M7 should change it; this only confirms it before the site is public.

- [ ] **Step 2 (cheap, optional): User sets the URLs** so any future auth email points at the live site. Authentication → URL Configuration: Site URL `https://loadcontrol.raphaelattar.com`; Redirect URLs add `https://loadcontrol.raphaelattar.com/**`. Password sign-in doesn't use them.

### Task 8: Live verification

- [ ] **Step 1: Open the live site** in the browser pane: `preview_start` with `url: https://loadcontrol.raphaelattar.com`. Check `read_console_messages` for errors and `read_network_requests` for failed loads (fonts, modules).

- [ ] **Step 2: User signs in** in the pane with the demo account. Claude never types the password.

- [ ] **Step 3: Check the flights page.** `read_page` shows the week's flights loaded from Supabase. No console errors.

- [ ] **Step 4: One live report.** Reports → mode "Claude only" → Generate. Wait for it to finish (about 15 s).
Expected: a complete seven-section report, status `ok`, cost about $0.002. The `generate-report` POST in `read_network_requests` has status 200, and the console shows no CORS error. If the network tool shows response headers, `access-control-allow-origin` is the live origin.

- [ ] **Step 5: Check the log row.**

Run: `supabase db query --linked "select provider_model, purpose, status, cost_usd, latency_ms, created_at from ai_calls order by created_at desc limit 1" </dev/null` (the saved CLI login, the same path `scripts/db-query.mjs` uses; no key file).
Expected: one `claude_write_report` row from the run just made, status `ok`.

- [ ] **Step 6: Screenshot** the finished report on the live URL for the user, and keep it for M8's demo backup.

### Task 9: Notes and commit

- [ ] **Step 1: Add "Added during execution"** at the end of this file: what actually happened at each task, the certificate wait time, the gitleaks result, the live run's cost and latency, and anything that differed from the plan.

- [ ] **Step 2: Run the scanners** on this file (`banned_phrase_scan.py`, `structure_scan.py --genre docs`) and fix what they confirm. Re-run `check-debrand.sh`.

- [ ] **Step 3: Commit and push on the user's word.**

```bash
git add docs/plans/m7-deploy.md
git commit -m "M7: notes from the live deploy"
git push
```
Expected: Pages redeploys. The site is unchanged, since only a doc changed.

---

**Done when (PRD section 12):** live on GitHub Pages under raphaelattar.com; the OpenRouter key listed only in Supabase secrets (Task 6 Step 1) and found nowhere in history (Task 4 Step 5); CORS locked to the live origin plus the preview origins; one report generated from the live site and logged.

**Left for M8:** README with the live URL, RUNBOOK (including "no alert when a scheduled run fails", how to roll back the deploy, and removing the preview origins after the interview), DEMO script. The first automatic scheduled run, Monday 2026-11-02 11:00 UTC, doesn't depend on any of this.

---

## Plan review

A subagent reviewed the first draft on 2026-10-27 and found two blocking problems, both fixed above. `gitleaks dir .` would have opened the git-ignored key file, so the scan is now history-only. The draft also used the airline's name five times, so committing it would have undone Task 1's cleanup; the plan now avoids the name. Other changes from the review: the final scan moved to just before the push, domain verification now comes before the DNS record (GitHub's guidance against subdomain takeover), the commit email exposure got a step, the Done-when items each got a check, and the OpenRouter credit limit gets confirmed before going public. The reviewer confirmed the CORS fallback, the Cloudflare wildcard behaviour, the `verify_jwt = false` expectation, and the CLI usages.
