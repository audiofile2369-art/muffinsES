"""SQLite database helpers for the backend."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine

from backend.config.settings import get_logger, get_settings

LOGGER = get_logger(__name__)


def ensure_item_quantity_column(engine: Engine) -> bool:
    """Add `item.quantity` to databases created before it existed.

    `create_all` never adds columns to existing tables, so this small, idempotent
    migration does it. It only ever adds a column (never drops or rewrites data)
    and logs instead of raising so a failure cannot stop the app from starting.
    Returns True when the column was added.
    """

    try:
        inspector = inspect(engine)
        if not inspector.has_table("item"):
            return False
        column_names = {column["name"] for column in inspector.get_columns("item")}
        if "quantity" in column_names:
            return False
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE item ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1"))
        LOGGER.info("Added missing item.quantity column")
        return True
    except Exception as error:  # noqa: BLE001 - never block startup on this migration
        LOGGER.warning("Could not ensure item.quantity column: %s", error)
        return False


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
        ensure_item_quantity_column(self.engine)
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
