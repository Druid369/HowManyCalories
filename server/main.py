from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from server.services.claude_vision import analyze_image
from server.config import MAX_IMAGE_SIZE_MB, ANTHROPIC_API_KEY

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="HowManyCalories", version="0.1.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


@app.post("/api/analyze")
@limiter.limit("10/minute")
async def analyze(
    request: Request,
    image: UploadFile = File(...),
    portion_hint: str | None = Form(default=None),
):
    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, "API key not configured — UI-only mode")

    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported image type: {image.content_type}. Use JPEG, PNG, or WebP.")

    image_bytes = await image.read()
    if len(image_bytes) > MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"Image too large. Maximum size is {MAX_IMAGE_SIZE_MB}MB.")

    try:
        result = await analyze_image(image_bytes, image.content_type, portion_hint)
    except ValueError as e:
        raise HTTPException(500, f"Failed to parse analysis: {e}")
    except Exception as e:
        raise HTTPException(500, f"Analysis failed: {e}")

    if not result.get("is_food"):
        raise HTTPException(422, detail={
            "error": "no_food_detected",
            "message": "No food was detected in this image. Please try a different photo.",
            "notes": result.get("notes", ""),
        })

    return result


@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.get("/landing")
async def landing():
    return FileResponse("static/landing/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
