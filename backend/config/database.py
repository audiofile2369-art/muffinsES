"""SQLite database helpers for the backend."""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine

from backend.config.settings import get_logger, get_settings

LOGGER = get_logger(__name__)


def ensure_column(
    engine: Engine,
    table: str,
    column: str,
    ddl: str,
    index_name: str | None = None,
) -> bool:
    """Add `table.column` (declared by `ddl`) to databases created before it existed.

    `create_all` never adds columns to existing tables, so this small, idempotent
    migration does it. It only ever adds a column (and optionally an index) --
    never drops or rewrites data -- and logs instead of raising so a failure
    cannot stop the app from starting. Returns True when the column was added.
    """

    try:
        inspector = inspect(engine)
        if not inspector.has_table(table):
            return False
        column_names = {existing["name"] for existing in inspector.get_columns(table)}
        added = False
        with engine.begin() as connection:
            if column not in column_names:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                added = True
            if index_name:
                connection.execute(text(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table} ({column})"))
        if added:
            LOGGER.info("Added missing %s.%s column", table, column)
        return added
    except Exception as error:  # noqa: BLE001 - never block startup on this migration
        LOGGER.warning("Could not ensure %s.%s column: %s", table, column, error)
        return False


def ensure_item_quantity_column(engine: Engine) -> bool:
    """Add `item.quantity` (default 1) to databases created before it existed."""

    return ensure_column(engine, "item", "quantity", "INTEGER NOT NULL DEFAULT 1")


def ensure_item_sale_event_order_column(engine: Engine) -> bool:
    """Add the nullable `itemsaleevent.order_id` (customer sale link) plus its index.

    Existing sale rows keep NULL (a sale recorded before checkouts existed).
    Adding a nullable column without a default is a metadata-only change in
    Postgres and SQLite, so it neither rewrites nor locks existing rows for long.
    """

    return ensure_column(engine, "itemsaleevent", "order_id", "INTEGER", "ix_itemsaleevent_order_id")


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
        ensure_item_sale_event_order_column(self.engine)
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
