"""Application settings and logging helpers."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    """Typed runtime settings for the application."""

    project_root: Path
    data_dir: Path
    database_url: str
    database_source: str
    neon_db_path: Path
    openai_api_key_path: Path
    pricing_model: str
    uploads_dir: Path
    api_prefix: str
    frontend_origins: tuple[str, ...]
    app_name: str


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return cached application settings."""

    project_root = Path(__file__).resolve().parents[2]
    # Serverless platforms (e.g. Vercel) ship a read-only bundle; only /tmp is
    # writable. Put any runtime-writable paths there when running on Vercel.
    writable_root = Path("/tmp/muffines") if os.getenv("VERCEL") else project_root
    data_dir = writable_root / "data"
    uploads_dir = data_dir / "uploads"
    neon_db_path = project_root / "neon_db.txt"
    openai_api_key_path = project_root / "open api.txt"
    database_url_override = os.getenv("MUFFINES_DATABASE_URL")
    database_path_override = os.getenv("MUFFINES_DATABASE_PATH")
    pricing_model = os.getenv("MUFFINES_PRICING_MODEL", "gpt-4.1-mini")

    if database_url_override:
        database_url = normalize_database_url(database_url_override)
        database_source = "environment URL"
    elif database_path_override:
        database_url = f"sqlite:///{Path(database_path_override)}"
        database_source = "environment path"
    elif neon_db_path.exists():
        database_url = normalize_database_url(
            neon_db_path.read_text(encoding="utf-8").strip()
        )
        database_source = "neon_db.txt"
    else:
        database_url = f"sqlite:///{data_dir / 'muffines.db'}"
        database_source = "local SQLite fallback"

    return Settings(
        project_root=project_root,
        data_dir=data_dir,
        database_url=database_url,
        database_source=database_source,
        neon_db_path=neon_db_path,
        openai_api_key_path=openai_api_key_path,
        pricing_model=pricing_model,
        uploads_dir=uploads_dir,
        api_prefix="/api",
        frontend_origins=("http://127.0.0.1:5173", "http://localhost:5173"),
        app_name="MuffinES",
    )


def normalize_database_url(raw_url: str) -> str:
    """Normalize external database URLs for the installed SQLAlchemy drivers."""

    if raw_url.startswith("postgresql://"):
        return raw_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return raw_url


def get_logger(name: str) -> logging.Logger:
    """Return a configured logger for the requested module."""

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    return logging.getLogger(name)
