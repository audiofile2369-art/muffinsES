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
    database_path: Path
    uploads_dir: Path
    api_prefix: str
    frontend_origins: tuple[str, ...]
    app_name: str


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return cached application settings."""

    project_root = Path(__file__).resolve().parents[2]
    data_dir = project_root / "data"
    uploads_dir = data_dir / "uploads"
    database_path = Path(
        os.getenv("MUFFINES_DATABASE_PATH", str(data_dir / "muffines.db"))
    )

    return Settings(
        project_root=project_root,
        data_dir=data_dir,
        database_path=database_path,
        uploads_dir=uploads_dir,
        api_prefix="/api",
        frontend_origins=("http://127.0.0.1:5173", "http://localhost:5173"),
        app_name="MuffinES",
    )


def get_logger(name: str) -> logging.Logger:
    """Return a configured logger for the requested module."""

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    return logging.getLogger(name)
