"""SQLite database helpers for the backend."""

from __future__ import annotations

from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from backend.config.settings import get_logger, get_settings

LOGGER = get_logger(__name__)


class Database:
    """Own the SQLModel engine and schema lifecycle."""

    def __init__(self) -> None:
        """Initialize the engine using configured filesystem paths."""

        settings = get_settings()
        # Tolerate read-only filesystems (e.g. Vercel) so importing this module
        # never crashes the serverless function at cold start.
        try:
            settings.data_dir.mkdir(parents=True, exist_ok=True)
            settings.uploads_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            LOGGER.warning("Could not create local data directories: %s", error)
        engine_kwargs: dict[str, object] = {"pool_pre_ping": True}
        if settings.database_url.startswith("sqlite"):
            engine_kwargs["connect_args"] = {"check_same_thread": False}

        self.engine = create_engine(settings.database_url, **engine_kwargs)

    def create_tables(self) -> None:
        """Create all declared database tables."""

        SQLModel.metadata.create_all(self.engine)
        settings = get_settings()
        LOGGER.info(
            "Database schema ensured using %s (%s)",
            settings.database_source,
            settings.database_url.split("@")[-1] if "@" in settings.database_url else settings.database_url,
        )

    def get_session(self) -> Session:
        """Create a new SQLModel session."""

        return Session(self.engine)

    def close(self) -> None:
        """Dispose the underlying engine."""

        self.engine.dispose()


database = Database()


def get_db() -> Iterator[Session]:
    """Yield a request-scoped database session."""

    with database.get_session() as session:
        yield session


def close_db() -> None:
    """Close global database resources."""

    database.close()
