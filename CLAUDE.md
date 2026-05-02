# HowManyCalories — Project Instructions

## What This Is
A PWA that lets users photograph food and get instant calorie/macro estimates, powered by Claude Vision API. No signup required. Mobile-first. Russian/CIS market focus.

Production target: Railway (Procfile + runtime.txt).

## Tech Stack
- **Backend:** FastAPI (Python 3.11+), Anthropic SDK, slowapi rate limiting, aiosqlite
- **Frontend:** Vanilla HTML/CSS/JS, no build step, no framework
- **Storage:** SQLite (`data/scans.db`) for full scan history + admin dashboard. localStorage on the client for personal history.
- **Image storage:** disk under `data/images/{sha256}.{ext}` for admin review
- **AI:** Claude Sonnet 4.6 (Stage 1 vision) + Claude Opus 4.6 (Stage 3 judge)
- **Nutrition data:** Local Russian food DB → USDA FoodData Central → OpenFoodFacts → AI fallback

## Running Locally
```bash
# 1. .env (never committed)
ANTHROPIC_API_KEY=sk-ant-...
USDA_API_KEY=...           # optional, falls back to DEMO_KEY
ENV=dev                    # dev|prod

# 2. install + run
pip install -r requirements.txt
uvicorn server.main:app --reload --host 0.0.0.0 --port 8000
```

App: http://localhost:8000
Admin dashboard: http://localhost:8000/admin
Landing page: http://localhost:8000/landing

## Architecture
```
server/
  main.py                   FastAPI entry; routes for /api/analyze, /api/admin/*,
                            page routes for /, /admin, /landing
  config.py                 env-based settings (ANTHROPIC_API_KEY, models, DB_PATH, ENV)
  database.py               aiosqlite — scans table + dashboard query helpers
  logging_config.py         structured JSON logging with ContextVar request IDs
  services/
    claude_vision.py        3-stage AI pipeline orchestrator (see below)
    russian_foods.py        ~150 Russian/CIS foods, prefix-matched search
    usda.py                 USDA FoodData Central client + scoring
    openfoodfacts.py        OpenFoodFacts client + scoring
  api/                      RESERVED — currently empty; routes still in main.py
  models/                   RESERVED — Pydantic schemas pending
static/
  index.html, css/app.css, js/app.js, js/spring.js   Main scanner SPA
  admin/                    Brutalist admin dashboard (gated by session, role='admin')
  login/                    Login + register screen (session-cookie auth)
  landing/                  Marketing landing page
data/
  scans.db                  SQLite (gitignored)
  images/                   Uploaded scans by SHA256 (gitignored)
Procfile, runtime.txt       Railway deployment config
```

## The 3-stage analyze pipeline
`POST /api/analyze` runs:
1. **Stage 1 — Sonnet vision**: identifies foods, estimates portions via chain-of-thought reasoning, emits per-item AI nutrition values + a USDA search term.
2. **Stage 2 — DB enrichment** (`_enrich_item`): fallback chain per item:
   - Russian food DB (primary for target market)
   - USDA FoodData Central
   - OpenFoodFacts
   - AI estimate (last resort)
   Cross-validated against AI values via `_values_agree` (50% tolerance) — DB value preferred only when it agrees with AI.
3. **Stage 3 — Opus judge**: receives photo + Stage 2 draft, produces final verdict (item identification, portion sizes, nutrition). Stage 2 enrichment runs again on Opus's output. Failures preserve Stage 2 draft.

Every scan is logged to `scans` table with full stage-by-stage JSON for future training data.

## Auth (session cookies)
The whole app is gated. `/` redirects to `/login` if no session cookie.
Auth model: HttpOnly session cookie (`fork_session`) → server-side `sessions`
table → resolves to a row in `users`. Login/register endpoints under
`/api/auth/*`. Two seeded admins: `admin/1363` (lands on scanner, owns
historical data) and `0/1363` (auto-redirects to /admin on login). Both
have `role='admin'`. The legacy `X-Admin-Token` header / `ADMIN_TOKEN`
env var were removed; admin access is session-cookie + role='admin' only.

Sessions are rolling: every authenticated request slides both the DB
`expires_at` and the browser cookie's `Max-Age` forward by
`SESSION_LIFETIME_DAYS` (default 30). Active users stay logged in; only
true inactivity past the window triggers a logout.

## Per-user data model
Every user has their own copy of:
- Personal scan history (`entries` table — references `scans` for the
  source photo + AI output)
- Daily targets (`user_settings` JSON blob — kcal, water, macro %)
- Water log (`water_log` JSON blob — append-only `{ts, ml}` list)
- Profile fields (display_name, avatar_path, weight_kg, height_cm,
  gender, birth_year, activity_level — all on the `users` row)

Server is canonical for all of the above. localStorage on the client is a
fast-read cache that's reconciled to the server on app boot (sync
helpers in `static/js/api.js` + `storage.js`) and mirrored on every
write (PATCH/PUT/DELETE fire-and-forget). The `scans` table additionally
records every analyzed photo as an immutable training log; `scans` is
joined to `users.user_id` for admin views, but personal-history reads/
writes go through `entries`.

## Admin dashboard
`/admin` — server-side gated: only sessions with `role='admin'` reach it.
Endpoints under `/api/admin/*` use the same session check. The dashboard
has two tabs: **OVERVIEW** (existing scan-feed + KPIs + timeline; scans
list shows a USER column with avatar + username) and **USERS** (per-
account list with scan count, last login, role/status badges; click row
→ detail modal with profile fields, recent scans, and admin actions —
disable/enable, reset password, delete). Admin self-protection: an admin
can't disable, demote, or delete their own account.

Per-user daily scan cap (`MAX_SCANS_PER_USER_PER_DAY`, default 20)
applies to non-admin accounts; admins are exempt. Set to 0 to disable.

## Key Decisions
- **Sonnet for vision, Opus as judge** — best cost/quality split; Sonnet is fast at recognition, Opus catches errors
- **Conservative calorie bias** — overestimate rather than underestimate (better for dieters)
- **Triple-layer JSON parser** — Claude sometimes wraps JSON in markdown
- **Russian DB before USDA** — USDA has almost zero Russian cuisine entries
- **No frontend framework** — three small SPAs (scanner, admin, landing) don't justify the build chain

## API Contract
`POST /api/analyze` — multipart form, `image` file + optional `portion_hint` string.
Returns JSON: `{ items[], total, confidence, data_sources, health_insight, notes }`.

## Code Style
- Python: type hints, async/await, structured logging via `extra={...}`
- JS: vanilla ES6+, no transpilation, plain `<script>` tags
- CSS: mobile-first, dark warm theme for app; brutalist for admin/landing
- No unused code, no placeholder comments, no over-engineering

## Status
Working in production on Railway. MVP complete. Active areas: pipeline accuracy improvements, admin dashboard polish, clarification UX for ambiguous foods.
