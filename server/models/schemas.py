"""Pydantic schemas for the analyze pipeline and admin API.

These models define the boundary contract between:
  - the analyze pipeline (Sonnet → enrichment → Opus → frontend)
  - the admin API and its dashboard consumer

Internal AI fields (ai_calories, portion_reasoning, etc.) are NOT modeled here
— they live as dicts inside the pipeline because their shape mutates between
stages. Models start at the externally-observable boundaries.
"""

from datetime import date as DateType, timedelta
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

Confidence = Literal["high", "medium", "low"]
DataSource = Literal["verified", "russian_db", "usda", "openfoodfacts", "ai_branded", "ai_estimate"]
CookingMethod = Literal[
    "raw", "boiled", "steamed", "stewed", "baked", "grilled", "fried_pan", "fried_deep",
]


class CookingSuggestion(BaseModel):
    method:          CookingMethod
    label_ru:        str
    estimated_grams: int
    calories:        int
    protein_g:       float
    fat_g:           float
    carbs_g:         float
    sugar_g:         float = 0.0
    fiber_g:         float = 0.0


class Per100g(BaseModel):
    """Per-100g nutrient values. Lets the client rescale macros locally when
    the user edits an item's gram count, without a round-trip to the server."""
    calories:  float
    protein_g: float
    fat_g:     float
    carbs_g:   float
    sugar_g:   float = 0.0
    fiber_g:   float = 0.0


class Item(BaseModel):
    """A single food item in the final analysis result."""
    model_config = ConfigDict(extra="ignore")

    name:                  str
    estimated_grams:       float
    calories:              int
    protein_g:             float
    fat_g:                 float
    carbs_g:               float
    sugar_g:               float = 0.0
    fiber_g:               float = 0.0
    confidence:            Confidence = "medium"
    data_source:           Optional[DataSource] = None
    usda_match:            Optional[str] = None
    usda_search_term:      Optional[str] = None
    per_100g:              Optional[Per100g] = None
    is_raw_ingredient:     bool = False
    cooking_suggestions:   list[CookingSuggestion] = Field(default_factory=list)


class Total(BaseModel):
    calories:  int
    protein_g: float
    fat_g:     float
    carbs_g:   float
    sugar_g:   float = 0.0
    fiber_g:   float = 0.0


class LookupRequest(BaseModel):
    """Body of POST /api/lookup — used when the user adds an ingredient
    after analysis (e.g. a side dish the photo missed)."""
    name:             str = Field(..., min_length=1, max_length=200)
    grams:            float = Field(..., gt=0, le=9999)
    usda_search_term: Optional[str] = Field(None, max_length=200)


# ── Edit-validation agent ─────────────────────────────────────────────────


class ValidationRequestItem(BaseModel):
    """One item in the user's edited ingredient list, sent to the validation
    agent. `original_grams` is included when the user changed it — gives the
    model context to judge whether the new value is plausible."""
    name:            str             = Field(..., min_length=1, max_length=200)
    estimated_grams: float           = Field(..., gt=0, le=9999)
    original_grams:  Optional[float] = Field(None, gt=0, le=9999)


class ValidationItemVerdict(BaseModel):
    """Per-item verdict. When ok=False the model MUST set suggested_grams
    and reason; when ok=True both fields are absent."""
    index:           int
    ok:              bool
    suggested_grams: Optional[float] = None
    reason:          Optional[str]   = None


class ValidationVerdict(BaseModel):
    """Response body of POST /api/validate-edits. `verdict` is "concerns"
    iff any item has ok=False, otherwise "looks_right"."""
    verdict:      Literal["looks_right", "concerns"]
    items:        list[ValidationItemVerdict] = Field(default_factory=list)
    overall_note: str = ""


# ── Day quality agent ─────────────────────────────────────────────────────


class DayQualityRequestItem(BaseModel):
    """One consumed dish for a given day, sent to the day-quality agent.
    Lightweight — we only need name + macros + grams for the rollup."""
    name:            str   = Field(..., min_length=1, max_length=200)
    calories:        float = Field(..., ge=0)
    protein_g:       float = Field(0, ge=0)
    fat_g:           float = Field(0, ge=0)
    carbs_g:         float = Field(0, ge=0)
    estimated_grams: float = Field(0, ge=0)


class DayQualityRequest(BaseModel):
    """Body of POST /api/day-quality. The user's calorie target is sent
    along so the agent can ground its verdict in the right ratio.

    `date` is the client's local calendar date. We enforce ISO yyyy-mm-dd
    format and reject dates more than one day in the future (one day of
    slack absorbs UTC-vs-local timezone skew without letting clients ask
    for verdicts on far-future days that have no possible data)."""
    date:            str  = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    items:           list[DayQualityRequestItem]
    water_ml:        int  = Field(0, ge=0, le=20000)
    target_calories: int  = Field(2000, ge=500, le=8000)

    @field_validator("date")
    @classmethod
    def _validate_date(cls, v: str) -> str:
        try:
            d = DateType.fromisoformat(v)
        except ValueError as e:
            raise ValueError(f"Invalid date: {v}") from e
        if d > DateType.today() + timedelta(days=1):
            raise ValueError("Date must not be more than 1 day in the future")
        return v


class DayQualityVerdict(BaseModel):
    """One-line traffic-light verdict for a day's nutrition.
    color: green = balanced, yellow = ok with caveats,
           orange = needs work, red = far off."""
    color:   Literal["green", "yellow", "orange", "red"]
    summary: str = ""
    tip:     str = ""


class AnalysisResult(BaseModel):
    """The shape returned by POST /api/analyze."""
    model_config = ConfigDict(extra="ignore")

    is_food:        bool = True
    items:          list[Item]
    total:          Total
    confidence:     Confidence
    data_sources:   list[str] = Field(default_factory=list)
    health_insight: str = ""
    notes:          str = ""
    # SHA-256 of the uploaded image bytes. Lets the client reference the
    # original photo on later edit-validation calls without re-uploading.
    image_sha256:   Optional[str] = None
    # Phase 2: server-side identifiers stamped onto the response so the
    # client can update its eager-saved local entry with the canonical
    # ids and reach back to /api/entries/{entry_id} for consumed-toggle
    # / edit / delete. Both are None when /api/analyze short-circuits
    # (e.g. no_food path) before persisting.
    scan_id:        Optional[str] = None
    entry_id:       Optional[int] = None


# ── Admin DTOs ─────────────────────────────────────────────────────────────


class ScanSummary(BaseModel):
    """One row from /api/admin/scans (list view)."""
    model_config = ConfigDict(extra="allow")

    scan_id:              str
    created_at:           str
    image_sha256:         str
    media_type:           str
    image_size_bytes:     int
    total_calories:       Optional[int] = None
    item_count:           Optional[int] = None
    confidence:           Optional[Confidence] = None
    data_sources:         Optional[str] = None
    stage1_ms:            Optional[int] = None
    stage2_ms:            Optional[int] = None
    stage3_ms:            Optional[int] = None
    total_ms:             Optional[int] = None
    stage1_input_tokens:  Optional[int] = None
    stage1_output_tokens: Optional[int] = None
    stage3_input_tokens:  Optional[int] = None
    stage3_output_tokens: Optional[int] = None
    opus_used:            int = 0
    calorie_warn:         int = 0
    final_json:           Optional[str] = None


class ScansListResponse(BaseModel):
    total:  int
    count:  int
    offset: int
    scans:  list[ScanSummary]


class StatsResponse(BaseModel):
    total:               int
    today:               int
    week:                int
    month:               int
    avg_total_ms:        int
    avg_stage1_ms:       int
    avg_stage2_ms:       int
    avg_stage3_ms:       int
    avg_calories:        int
    avg_items:           float
    avg_tokens:          int
    total_tokens:        int
    opus_used_count:     int
    opus_rate:           float
    calorie_warn_count:  int
    confidence_dist:     dict[str, int]
    source_dist:         dict[str, int]
    # Edit-tracking signals — how often users correct the AI's analysis.
    # `edited_entries` is the count of entries whose `result_json` was
    # mutated at least once; `total_edits` is the sum of edit_count across
    # all entries (one entry edited 5 times = 5). `edit_rate` is the
    # percentage of entries edited at least once.
    entries_total:       int = 0
    edited_entries:      int = 0
    total_edits:         int = 0
    edit_rate:           float = 0.0
    # Image-dedup signals — how often the cache shortcut saved an
    # Anthropic call. `cached_count` is rows where cached=1 (final_json
    # reused from a prior identical-image scan); `cache_hit_rate` is the
    # percentage of all scans that were cache hits. Multiply by an
    # average per-scan cost to estimate savings.
    cached_count:        int = 0
    cache_hit_rate:      float = 0.0


class TimelineBucket(BaseModel):
    bucket:  str
    count:   int
    avg_ms:  int
    avg_cal: int


# ── Auth ──────────────────────────────────────────────────────────────────
# Wire format for /api/auth/{register,login,me,logout}. The username/password
# regex/length rules live in services/_auth.py (so they can be reused by the
# admin "create user" path too); here we just declare the field-level cap so
# Pydantic blocks pathological inputs (e.g. 10MB string) before they hit
# the validator.


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=4, max_length=128)
    # 152-ФЗ requires affirmative consent for personal data processing.
    # Must be True; the endpoint rejects False/missing with a 422 + Russian
    # message. Pre-Phase-1 clients that don't send this field will fail
    # validation, which is intentional — we want to know loudly rather
    # than silently accept a registration without consent.
    consent: bool = Field(...)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=128)


class UserPublic(BaseModel):
    """The shape returned by /api/auth/me and embedded in login/register
    responses. Never includes password_hash. `role` is 'guest' | 'user'
    | 'admin'; the client uses it to decide whether to show admin nav
    items, the guest scan-counter chip, etc."""
    model_config = ConfigDict(extra="ignore")

    id:             int
    username:       str
    role:           Literal["guest", "user", "admin"]
    status:         Literal["active", "disabled"]
    display_name:   Optional[str] = None
    avatar_path:    Optional[str] = None
    weight_kg:      Optional[float] = None
    height_cm:      Optional[float] = None
    gender:         Optional[Literal["m", "f", "other"]] = None
    birth_year:     Optional[int] = None
    activity_level: Optional[Literal["sedentary", "light", "moderate", "active", "very_active"]] = None
    created_at:     str
    last_login_at:  Optional[str] = None
    scan_count:     int = 0
    # Phase 3.5c: surface email fields so the frontend can render the
    # "verify your email" banner. password_hash is still filtered out
    # by _user_dict_to_public; these fields are safe to expose to the
    # owning user — they're already what the user sees in their inbox.
    email:          Optional[str] = None
    email_verified: bool = False


class AuthResponse(BaseModel):
    """Body of /api/auth/login and /api/auth/register. The session cookie
    is set as an HTTP-only Set-Cookie header alongside this body — the
    body's `user` field is for the client to render immediately without
    having to follow up with a /me call."""
    user: UserPublic


# ── Admin user-management DTOs (Phase 5) ─────────────────────────────────


class UserAdminPublic(UserPublic):
    """Augments UserPublic with admin-only derived stats. Used in the
    /api/admin/users response. `last_scan_at` is the most recent scan
    upload (NULL if the user never scanned)."""
    last_scan_at: Optional[str] = None


class AdminUserUpdate(BaseModel):
    """PATCH /api/admin/users/{id}. Status and role are the only fields
    an admin sets directly. Profile fields go through the user's own
    /api/auth/profile path; password reset has its own endpoint."""
    status: Optional[Literal["active", "disabled"]] = None
    role:   Optional[Literal["user", "admin"]] = None

    model_config = ConfigDict(extra="ignore")


class AdminResetPasswordRequest(BaseModel):
    """POST /api/admin/users/{id}/reset-password. Admin chooses the new
    password and shares it out-of-band (we don't have email infra). All
    of the target user's sessions are blown away after the reset, so
    they have to log in again with the new password."""
    password: str = Field(..., min_length=4, max_length=128)


class ChangePasswordRequest(BaseModel):
    """POST /api/auth/change-password — user-initiated password change.
    Requires the current password to defeat session-hijack attacks
    (otherwise an XSS would let an attacker rotate the password and
    lock the user out). New password is validated server-side via
    services._auth.validate_password."""
    current_password: str = Field(..., min_length=1, max_length=128)
    new_password:     str = Field(..., min_length=4, max_length=128)


class DeleteAccountRequest(BaseModel):
    """POST /api/auth/delete-account — user-initiated self-delete.
    Requires the current password as a destructive-action confirm
    (also defeats session-hijack mass-deletion). The seeded admin
    accounts (`admin`, `0`) are blocked at the route level. Optional
    `reason` is a free-text feedback field collected from the
    designed delete-account modal — logged server-side for product
    learning, not stored long-term."""
    password: str           = Field(..., min_length=1, max_length=128)
    reason:   Optional[str] = Field(None, max_length=500)


class UpgradeGuestRequest(BaseModel):
    """POST /api/auth/upgrade-guest — converts a logged-in guest to a
    real user IN PLACE (same user_id, so guest's scans/entries/settings
    survive). Caller's session cookie keeps working through the upgrade.

    Username may match the current `guestXXXXXXXX` (PRD: "let user
    choose to keep") OR a fresh user-chosen name. Email is required —
    no recovery path without it. Consent is required by 152-ФЗ; the
    endpoint also writes a consent_log row stamped with the current
    consent version."""
    username: str  = Field(..., min_length=1, max_length=32)
    email:    str  = Field(..., min_length=3, max_length=320)
    password: str  = Field(..., min_length=4, max_length=128)
    consent:  bool = Field(...)


class PasswordResetRequest(BaseModel):
    """Body of POST /api/auth/password-reset/request — public.
    The endpoint always returns 200 so the response shape never reveals
    whether `email` is registered. Field validation is intentionally
    lenient (just length + presence of '@'); we don't reject technically-
    weird emails because we don't know what providers our users use."""
    email: str = Field(..., min_length=3, max_length=320)


class PasswordResetConfirm(BaseModel):
    """Body of POST /api/auth/password-reset/confirm — public.
    Token comes from the link the user clicked; new password is what
    they typed in the reset form. Server validates password rules and
    consumes the token in one transaction."""
    token:        str = Field(..., min_length=20, max_length=200)
    new_password: str = Field(..., min_length=4, max_length=128)


class ProfileUpdate(BaseModel):
    """Body of PUT /api/auth/profile — partial update of the user's
    profile fields. All optional; only fields present in the request
    are written. Username, role, status, password are NOT settable
    here (separate endpoints exist or will exist for password change
    + admin role/status management).

    Range bounds are conservative to catch obvious typos ("50" cm
    height) without rejecting plausible values. Empty strings on
    display_name are coerced to None on the server (clearing the
    field) — clients can pass "" to remove a previously-set name.
    """
    display_name:   Optional[str] = Field(None, max_length=64)
    weight_kg:      Optional[float] = Field(None, ge=20, le=500)
    height_cm:      Optional[float] = Field(None, ge=80, le=250)
    gender:         Optional[Literal["m", "f", "other"]] = None
    birth_year:     Optional[int] = Field(None, ge=1900, le=2030)
    activity_level: Optional[Literal[
        "sedentary", "light", "moderate", "active", "very_active",
    ]] = None

    model_config = ConfigDict(extra="ignore")


# ── Entries (per-user personal history) ───────────────────────────────────
# Server shape mirrors what the localStorage `hmc_v1` cache used pre-Phase
# 2. `imageDataUrl` is named for backward compat — for server-sourced
# entries it's a regular URL (`/api/scans/{id}/image`), which `<img src>`
# accepts identically to a data URL, so renderers don't need updating.


class EntryPublic(BaseModel):
    """Item in the GET /api/entries response."""
    model_config = ConfigDict(extra="ignore")

    id:             int
    timestamp:      int           # epoch ms (matches localStorage `entry.timestamp`)
    imageDataUrl:   Optional[str] = None
    result:         dict
    totalCalories:  int = 0
    itemCount:      int = 0
    itemNames:      str = ""
    consumed:       bool = False


class EntryEditLogRecord(BaseModel):
    """One row from `entry_edit_log`. Captures a single field-level
    change a user made to an entry's analysis result. The (`field`,
    `old_value`, `new_value`) triple is the training-relevant payload;
    `item_index` and `item_name` give the item-level context.

    `field` values currently emitted by compute_entry_diff:
      - "item.name" / "item.estimated_grams" / "item.calories"
      - "item_added" / "item_removed"
      - "notes"
    """
    id:         int
    entry_id:   int
    user_id:    int
    edited_at:  str
    field:      str
    item_index: Optional[int] = None
    item_name:  Optional[str] = None
    old_value:  Optional[str] = None
    new_value:  Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class EntryUpdate(BaseModel):
    """PATCH body for /api/entries/{id}. All fields optional; the server
    only writes the columns that were provided. `result` (a dict) gets
    re-serialized server-side into result_json — the client never sees
    the raw JSON column."""
    consumed:       Optional[bool] = None
    result:         Optional[dict] = None
    total_calories: Optional[int] = Field(None, alias="totalCalories")
    item_count:     Optional[int] = Field(None, alias="itemCount")
    item_names:     Optional[str] = Field(None, alias="itemNames")
    notes:          Optional[str] = None

    model_config = ConfigDict(populate_by_name=True, extra="ignore")
