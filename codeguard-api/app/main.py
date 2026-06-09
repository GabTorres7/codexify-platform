from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles  # noqa: F401

from app.api.v1.router import api_router
from app.config import get_settings
from app.core.exceptions import CodeGuardException

logger = structlog.get_logger()
settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("codeguard_api_starting", env=settings.app_env)
    yield
    logger.info("codeguard_api_shutdown")


def create_app() -> FastAPI:
    app = FastAPI(
        title="CodeGuard API",
        description="AI-powered Merge Request analyzer — REST API",
        version="1.0.0",
        docs_url="/docs" if settings.debug else None,
        redoc_url="/redoc" if settings.debug else None,
        lifespan=lifespan,
    )

    # CORS — include frontend deploy URL automatically
    origins = list(settings.allowed_origins)
    if settings.frontend_url and settings.frontend_url not in origins:
        origins.append(settings.frontend_url)
    if settings.public_api_url and settings.public_api_url not in origins:
        origins.append(settings.public_api_url)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Global exception handler
    @app.exception_handler(CodeGuardException)
    async def codeguard_exception_handler(_request, exc: CodeGuardException):  # noqa: ARG001
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.error_code, "message": exc.message},
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(_request, exc: Exception):  # noqa: ARG001
        error_name = type(exc).__name__
        if "Supabase" in error_name or "Invalid API key" in str(exc):
            return JSONResponse(
                status_code=503,
                content={
                    "error": "DATABASE_UNAVAILABLE",
                    "message": "Supabase não configurado. Preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env",
                },
            )
        logger.error("unhandled_exception", error=str(exc), type=error_name)
        return JSONResponse(
            status_code=500,
            content={"error": "INTERNAL_ERROR", "message": str(exc)},
        )

    # Routes
    app.include_router(api_router, prefix="/api/v1")

    @app.get("/", include_in_schema=False)
    async def root():
        if settings.frontend_url:
            return RedirectResponse(url=settings.frontend_url)
        import pathlib
        landing = pathlib.Path(__file__).resolve().parent.parent.parent / "codeguard-ai" / "landing.html"
        if landing.is_file():
            from fastapi.responses import HTMLResponse
            return HTMLResponse(landing.read_text(encoding="utf-8"))
        return RedirectResponse(url="/app/index.html")

    @app.get("/health", tags=["Health"])
    async def health():
        return {"status": "ok", "version": "1.0.0"}

    # Serve frontend static files from codeguard-ai folder
    import pathlib
    frontend_dir = pathlib.Path(__file__).resolve().parent.parent.parent / "codeguard-ai"
    if frontend_dir.is_dir():
        app.mount("/app", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")

    return app


app = create_app()
