# HowManyCalories — Project Instructions

## What This Is
A PWA that lets users photograph food and get instant calorie/macro estimates, powered by Claude Vision API. No signup required. Mobile-first.

## Tech Stack
- **Backend:** FastAPI (Python 3.11+), Anthropic SDK
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Storage:** localStorage for scan history (no database in MVP)
- **AI:** Claude Sonnet via vision API — system prompt in `server/services/claude_vision.py`

## Running Locally
```bash
cp .env.example .env        # Add your ANTHROPIC_API_KEY
pip install -r requirements.txt
uvicorn server.main:app --reload --host 0.0.0.0 --port 8000
```
Open http://localhost:8000

## Architecture
```
server/main.py          → FastAPI entry point, serves static files + API
server/api/analyze.py   → POST /api/analyze endpoint
server/services/claude_vision.py → Claude API call, prompt, JSON parsing
server/models/schemas.py → Pydantic models (Phase 1+)
server/config.py        → Environment-based settings
static/                 → Frontend SPA (served by FastAPI)
```

## Key Decisions
- **Claude Sonnet** (not Opus) for vision — best cost/quality tradeoff
- **No framework** for frontend — 3-4 screens don't justify React/Vue overhead
- **localStorage** not DB — MVP doesn't need accounts or server-side persistence
- **Conservative calorie bias** — overestimate rather than underestimate (better for dieters)
- **Triple-layer JSON parser** — Claude sometimes wraps JSON in markdown; we handle it

## API Contract
`POST /api/analyze` — multipart form with `image` file + optional `portion_hint` string.
Returns JSON with `items[]`, `total`, `confidence`, `notes`. See `server/services/claude_vision.py` for full schema.

## Code Style
- Python: standard library conventions, type hints, async where FastAPI requires it
- JS: vanilla ES6+, no transpilation, no modules (single HTML file in Phase 0, separate files later)
- CSS: mobile-first, dark theme, minimal — no CSS framework
- No unused code, no placeholder comments, no over-engineering

## Phase Plan
- Phase 0: Skeleton (file upload → Claude → display) ✅
- Phase 1: Structured JSON response + clean mobile UI
- Phase 2: Camera capture + client-side image resize
- Phase 3: localStorage history + PWA (manifest, service worker)
- Phase 4: Polish, rate limiting, edge cases
