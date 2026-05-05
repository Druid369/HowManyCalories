# Phase 4 — Production Deploy to Amvera

> **Audience:** Eugene + any future Claude session continuing this work.
> **Intent:** Self-contained deploy runbook. Read top to bottom before
> touching anything. Italics mark items that only Eugene can do; plain
> text marks items Claude can execute or assist with.

---

## 0 · Status snapshot

**What is being deployed.** Single FastAPI process serving the
HowManyCalories PWA — backend (`server/`) + three SPAs in `static/`
(scanner `/`, admin `/admin`, login `/login`). Stateful pieces live on
disk: SQLite DB at `data/scans.db`, scan images at `data/images/`,
avatar PNGs at `data/avatars/`. No external DB, no Redis, no broker.

**Migrating from where.** Currently running on Railway under the
`Procfile` + `runtime.txt` config that landed in commit `4e67109`.
Production data (DB + images + avatars) lives on Railway's volume.

**Migrating to where.** Amvera (Russian Railway-equivalent), serving
under the custom domain `myfork.ru`. Decision rationale (152-ФЗ data
localization + Russian datacenter latency) lives in
`plan-next-chat.json` → `decisions_made.data_localization_152fz`.

**Why this is "do last".** Per Eugene's build-everything-first plan,
Phases 1-3, 0.5, 5, 6 (a/b/c) all shipped before this. Code is
feature-complete; hosting migration is the only blocker between current
Railway-running state and the final myfork.ru launch.

---

## 1 · Pre-flight blockers (Eugene-only)

Every item below must be true **before** any deploy work begins. None
of these can be done by Claude.

| # | Item | Status | Where it surfaces |
|---|------|--------|-------------------|
| 1 | *Replace placeholder operator name* `Иванов Иван Иванович` + city `Москва` with real ФИО + city of residence | TODO | `server/config.py:75-76` (env-overridable: `OPERATOR_NAME`, `OPERATOR_CITY`); also rendered into `/privacy`, `/terms`, and the Roskomnadzor template |
| 2 | *Rotate the Unisender Go API key* — the value pasted into chat 2026-05-04 must be considered burned | TODO | env var `UNISENDER_API_KEY` (set on Amvera, **never** in repo) |
| 3 | *Rotate the GitHub Personal Access Token* embedded in `.git/config` remote URL (Claude flagged this 2026-05-05) | TODO | `git remote -v` shows `ghp_...` in the URL — revoke at https://github.com/settings/tokens, generate fresh, then `git remote set-url origin https://github.com/Druid369/HowManyCalories.git` so Git uses Windows Credential Manager instead |
| 4 | *Verify sender domain* `myfork.ru` at Unisender Go (DKIM + SPF + return-path) — needs DNS live first, so this comes during step 3 below, not before | TODO | Without verification, Yandex/Mail.ru spam-filter our confirmation/reset emails — most Russian inboxes will never see them |
| 5 | *Submit Roskomnadzor notification* of personal-data processing | TODO | Template at `docs/roskomnadzor-notification.md` — Eugene fills `[ЗАПОЛНИТЬ]` fields, submits at https://pd.rkn.gov.ru → free, ~30-day approval |
| 6 | *Confirm Amvera billing tier* — recommended 5GB volume; budget 3000-5000 RUB/month per `plan-next-chat.json.decisions_made.hosting_budget` | TODO | https://amvera.ru |

> **Sequencing note.** Items 1, 2, 3 should be done immediately — they
> are pure config / credential hygiene and don't depend on Amvera.
> Item 5 (Roskomnadzor) can be submitted any time but the form's
> "дата начала обработки" field expects a real launch date; submit
> AFTER step 7 (DNS cutover) so the date is honest.

---

## 2 · Amvera project setup

### 2a · Create the project
1. Eugene logs into https://amvera.ru
2. Create new project, name `howmanycalories` (or similar)
3. **Connect GitHub repo** `Druid369/HowManyCalories`. Amvera will
   auto-pull on every push to `main`.
4. Build config:
   - Runtime: **Python 3.11.11** (matches `runtime.txt`)
   - Install command: `pip install -r requirements.txt`
   - Run command: `uvicorn server.main:app --host 0.0.0.0 --port $PORT`
   - Health-check endpoint: `/health` (already implemented; returns
     `{"status":"ok", ...}` with `scan_write_failures` counter)

### 2b · Mount persistent volume
Amvera's persistent volumes survive redeploys. Without one, every push
wipes the DB + images + avatars.

- **Mount point:** `/data` (matches the `DB_PATH` env var below)
- **Size:** 5 GB starting tier (current Railway usage is < 100 MB; 5 GB
  gives ~5 years of headroom at observed growth)
- **Backup policy:** Amvera tier-dependent; verify retention before
  trusting it as the only copy.

### 2c · Environment variables
Set every variable below in Amvera's dashboard. **Anything containing
a secret must never be committed to the repo or echoed in any log.**

| Var | Value | Source / notes |
|-----|-------|----------------|
| `ENV` | `prod` | Triggers `IS_PROD=True` → enables HSTS header, `SESSION_COOKIE_SECURE=true`, locks down CORS |
| `ANTHROPIC_API_KEY` | (Anthropic console) | Required; without it `/api/analyze` 503s |
| `USDA_API_KEY` | (api.data.gov key) | Optional; falls back to `DEMO_KEY` (30/hr quota) |
| `DB_PATH` | `/data/scans.db` | Forces SQLite onto the persistent volume |
| `SEED_ADMIN_PASSWORD` | (strong random) | Without this in prod, the `admin` seed account is **not created** (intentional safety per `config.py:60`). Generate fresh; do not reuse the dev `1363`. |
| `SEED_SUPERADMIN_PASSWORD` | (strong random, different from above) | Same logic for the `0` account. |
| `UNISENDER_API_KEY` | (rotated key from blocker #2) | Triggers actual email sends. Without it, `EMAIL_TRANSPORT=api` will log `email_send_no_api_key` and return 503 |
| `EMAIL_TRANSPORT` | `api` | Switch from dev's `log` to real send. Tested round-trip should land in Eugene's inbox before flipping. |
| `UNISENDER_FROM_EMAIL` | `noreply@myfork.ru` | Default already correct |
| `UNISENDER_FROM_NAME` | `FORK` | Default already correct |
| `APP_BASE_URL` | `https://myfork.ru` | Used to build verify/reset URLs inside emails. **Critical** — wrong value sends users to localhost links. |
| `CORS_ORIGINS` | `https://myfork.ru` | In prod the default is `[]` (deny-all); set explicitly to allow same-origin |
| `SESSION_COOKIE_SECURE` | leave unset | Auto-derives from `IS_PROD`; explicit override only if Amvera terminates TLS upstream and the app sees plain HTTP |
| `OPERATOR_NAME` | (real ФИО from blocker #1) | Renders into `/privacy`, `/terms`, `/api/legal/info` |
| `OPERATOR_CITY` | (real city from blocker #1) | Same as above |
| `CONSENT_VERSION_CURRENT` | leave default `v1.2026-05` | Bump only when privacy policy materially changes |
| `MAX_SCANS_PER_USER_PER_DAY` | `20` (default) | Per-user daily AI cap; `0` disables. Tighten in prod if cost goes wild. |
| `LOGIN_THROTTLE_*` | leave defaults | Phase 0.5.3 per-username login throttle (10 fails / 15min → 5min lock) |

> **Where each var is read.** All defined in `server/config.py`. If a
> required var is missing, the app starts but the relevant feature
> silently falls back (e.g. no `ANTHROPIC_API_KEY` → 503 on analyze) —
> verify each individually after first deploy.

---

## 3 · DNS at REG.ru

### 3a · Cutover-ready record
1. Eugene logs into REG.ru control panel for `myfork.ru`
2. Delete any default A-record pointing to REG.ru parking
3. Add **A-record** `@` → Amvera's allocated IP (Amvera shows it under
   the project's "Domain" tab). If Amvera offers a CNAME alias, use
   that instead — IP can change.
4. Add **A-record** `www` → same IP, OR set up a 301 redirect
   `www.myfork.ru → myfork.ru` at Amvera's level
5. **TTL = 300 seconds** (5 min) for the cutover window. Bump back to
   3600 (1 hour) after 48h of stable operation.

### 3b · DKIM / SPF for Unisender Go (blocker #4 lands here)
Once DNS is live and resolves to Amvera, configure Unisender's sender
verification:
- Add the **TXT record** for SPF that Unisender Go provides (typically
  `v=spf1 include:_spf.unisender.com ~all` — verify in their docs)
- Add the **DKIM TXT record** Unisender generates (selector + value
  shown in their UI)
- Add a return-path subdomain CNAME if their setup requires it
- Confirm in Unisender's UI that all three records show ✓ green

> **Without this, Yandex and Mail.ru will spam-filter every confirm/
> reset email.** That breaks the password-reset flow for ~70% of
> Russian users. Don't skip.

### 3c · TLS
Amvera handles Let's Encrypt automatically once DNS resolves to their
IP. Verify HTTPS works at `https://myfork.ru` before promoting traffic.
Plain HTTP requests should auto-redirect to HTTPS.

---

## 4 · Data migration from Railway (only if there's user data worth keeping)

> **Skip this entire section if Railway has no real-user data** —
> seeding fresh is faster and cleaner. The `lifespan` startup hook in
> `server/main.py` runs every idempotent migration + seeds the admin
> accounts, so a fresh Amvera deploy has a fully usable DB after first
> boot.

If Railway does have real data:

1. **Export from Railway:**
   - SCP / Railway-CLI download `data/scans.db`, `data/images/`,
     `data/avatars/` to local
   - Verify file sizes match what's on Railway (no truncation)
   - **Take a backup copy** of the local pull before uploading anywhere

2. **Upload to Amvera volume:**
   - Use Amvera's volume-upload mechanism (SFTP / dashboard / CLI per
     their docs)
   - Path mapping: local `data/scans.db` → Amvera `/data/scans.db`,
     same for `images/` and `avatars/`

3. **Verify on Amvera:**
   - SSH into Amvera (or use their shell access) and run
     `sqlite3 /data/scans.db "SELECT count(*) FROM users;"` — should
     match Railway count
   - Same for `scans`, `entries`, `consent_log`, `email_tokens`

4. **Re-run lifespan migrations.** When the app boots on Amvera, the
   `lifespan` hook in `server/main.py` automatically runs every
   `init_*` migration (consent_log, email columns, email_tokens, etc.)
   — these are idempotent, so they're safe even on a populated DB.
   Verify by tailing logs for `init_*_table` log lines on first boot.

---

## 5 · Pre-cutover smoke test

Before flipping DNS, exercise everything end-to-end on Amvera's
staging URL (Amvera assigns one like `howmanycalories.amvera.io` or
similar before custom-domain).

Run through this list **in order**:

1. ☐ `GET /health` → 200, JSON with `scan_write_failures: 0`
2. ☐ `GET /robots.txt` → 200, lists `/api/`, `/admin`, `/login`,
   `/reset` as Disallow
3. ☐ `GET /` → auto-spawns guest, serves the scanner SPA
4. ☐ Login as `admin` (using the new `SEED_ADMIN_PASSWORD`) → reaches
   the scanner
5. ☐ Login as `0` → auto-redirects to `/admin` dashboard
6. ☐ Upload a real food photo → 3-stage AI pipeline runs end-to-end →
   result card renders → entry created
7. ☐ Edit an item's grams → save → check `entry_edit_log` got a row
   via admin dashboard
8. ☐ Open Account Settings sub-sheet → add an email → confirmation
   arrives in Eugene's inbox within 60s (test with at least one
   Yandex address — that's the deliverability canary for Russian
   users)
9. ☐ Click the verify link → redirects to `/?verified=1` → pill
   updates to "Подтверждён"
10. ☐ Trigger password reset from `/login` → email arrives → click
    link → `/reset` SPA loads → set new password → login with new
    password works
11. ☐ Hit response headers on any page — confirm CSP, HSTS,
    X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
    Permissions-Policy all present (HSTS will only appear once
    `IS_PROD=true` is set)
12. ☐ Hit `/api/auth/login` 11 times with wrong password for the same
    username → 11th returns 429 with Retry-After header
13. ☐ Upload a non-image file with `Content-Type: image/jpeg` →
    rejected with 400 (Phase 0.5.2 magic-byte check)

---

## 6 · DNS cutover

Run this **only after every smoke-test item above passes** on the
Amvera staging URL.

1. **Pre-cutover.** Confirm Railway is still running and serving
   `https://<old-railway-url>`. Don't shut it down yet.
2. **Lower TTL** on Railway's DNS record (if it points anywhere) to
   300s and wait the old TTL window so propagation is fast in step 4.
3. **Flip the DNS A-record** at REG.ru: `@` and `www` from
   Railway-IP → Amvera-IP. (Or update the CNAME alias if using one.)
4. **Wait for propagation** — should complete in ~5 min with TTL=300.
   Verify via `dig myfork.ru +short` from a few different networks
   (mobile data + home WiFi at minimum).
5. **Smoke-check production.** Re-run items 1, 3, 4, 6, 8 from
   section 5 above against `https://myfork.ru` directly.
6. **24-hour soak.** Keep Railway running and warm in case rollback
   is needed. Monitor Amvera logs.
7. **Decommission Railway.** After 48h of stable Amvera operation
   with no rollbacks, shut down the Railway project. Save a final
   `data/scans.db` snapshot from Railway as cold backup before
   destroying the volume.

---

## 7 · Post-cutover monitoring (first 48h)

### 7a · Logs to watch
The app emits structured JSON logs via `server/logging_config.py`. On
Amvera's log viewer, filter on these `event` values:

| Event | What it means | Action |
|-------|---------------|--------|
| `scan_write_failures` increment in `/health` | DB write failed | Check disk space + permissions on `/data` |
| `email_send_failed` / `email_send_network_error` | Unisender send failed | Verify API key + DKIM/SPF |
| `login_throttle_locked` | Per-username brute-force triggered | Check IP — if widespread, Eugene's account may be under attack |
| `rate_limit_hit` (Phase 0.5.7) | slowapi 429 fired | Sustained = legit user hitting limits or attacker; check `path` field |
| `analyze_magic_mismatch` | Image magic-byte mismatch | One-off = browser quirk; bursts = scanning bot |
| `ERROR` level anywhere | Unexpected | Investigate immediately |

### 7b · External health check
Set up **UptimeRobot** (free tier) to ping `https://myfork.ru/health`
every 5 minutes. Alert via email + Telegram on 2 consecutive failures.

### 7c · Cost tracking
- **Anthropic console** — watch daily spend vs. baseline. Phase 0.5.6
  tightened `/api/validate-edits` to 3/min; per-user daily cap on
  `/api/analyze` is `MAX_SCANS_PER_USER_PER_DAY=20` (admins exempt).
- **Unisender Go** — watch deliverability rate per recipient domain.
  `< 90%` to Yandex/Mail.ru = DKIM/SPF problem.

---

## 8 · Rollback procedure

**If anything goes wrong in the first 48h, roll back. Do NOT try to
fix forward under live traffic.**

1. **DNS rollback.** At REG.ru, change the A-records back to
   Railway's IP. With TTL=300, traffic returns to Railway in ~5 min.
2. **Don't touch Amvera.** Leave it as-is so logs and state are
   preserved for post-mortem.
3. **Verify Railway is serving traffic.** Hit `myfork.ru` once
   propagation completes; should return Railway-served pages.
4. **Investigate the failure** with logs from both sides. Common
   causes:
   - Volume mount missing → DB writes silently fail (`scan_write_failures` climbs)
   - `APP_BASE_URL` wrong → email links 404
   - Unisender API key not set → 503 on email send
   - `ENV` not `prod` → cookies missing `Secure`, browsers reject them

---

## 9 · Update CLAUDE.md after stable cutover

Once Amvera has run cleanly for 48h+:

1. Edit `c:/Work/HowManyCalories/CLAUDE.md`:
   - Replace "Production target: Railway (Procfile + runtime.txt)"
     with "Production target: Amvera (custom domain myfork.ru)"
   - Update the architecture / "Running" sections accordingly
2. Delete or rewrite `Procfile` + `runtime.txt` if Amvera doesn't use
   them (depends on Amvera's deploy mechanism — likely just keep
   `runtime.txt` for the Python version pin).
3. Commit + push: `Phase 4: Amvera deployment — replace Railway docs`

---

## 10 · Reference — secret rotation log

Maintain this table going forward. Every time a secret rotates, add a
row. Never write the secret itself — just date + reason + who.

| Date | Secret | Reason | Action by |
|------|--------|--------|-----------|
| 2026-05-04 | `UNISENDER_API_KEY` (initial) | Pasted in chat — must be considered burned | Eugene to rotate before deploy |
| 2026-05-05 | `GitHub PAT` (`ghp_zP5I8...`) | Embedded in `.git/config` remote URL — read by Claude session | Eugene to rotate before next push |

---

## 11 · Reference — useful URLs

- Amvera: https://amvera.ru
- REG.ru control panel: https://www.reg.ru/user
- Roskomnadzor PDN portal: https://pd.rkn.gov.ru
- Unisender Go: https://go.unisender.ru
- Anthropic console: https://console.anthropic.com
- USDA FoodData Central key request: https://fdc.nal.usda.gov/api-key-signup.html
- UptimeRobot: https://uptimerobot.com
- This project on GitHub: https://github.com/Druid369/HowManyCalories
- Telegram support handle: https://t.me/ForkWorkBro

---

## 12 · Decision log (for the record)

Captured decisions that drove the design of this deploy plan. Update
when assumptions change.

- **Why Amvera over Selectel VPS:** Eugene is non-programmer; Amvera's
  git-push-to-deploy + managed SSL + dashboard volume management
  removes the Docker/Nginx/CI/CD setup burden Selectel would impose.
  If Amvera turns out too restrictive, fallback is Selectel.
- **Why custom domain `myfork.ru`:** Brand fit (FORK app); registered
  early at REG.ru per `plan-next-chat.json` decisions.
- **Why 5GB volume:** ~50× current usage headroom. Cheap enough that
  oversizing is fine; resizing later costs downtime.
- **Why launch as физическое лицо:** Eugene has no legal entity yet;
  fully legal for MVP per Russian law. Switch to ИП once 10+ active
  users or monetization starts.
- **Why deploy LAST in the build order:** Eugene's "build everything
  first" plan — get every feature shippable, THEN move hosting in one
  controlled cutover, rather than iterating frontend changes on a live
  production environment with real users watching.
