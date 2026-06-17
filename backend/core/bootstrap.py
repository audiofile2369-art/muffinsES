"""Database initialization helpers."""

from __future__ import annotations

from sqlmodel import Session, delete, select

from backend.core.models import Category, Item, Sale, Task

LEGACY_DEMO_SALE_TITLES = {
    "Willow Creek Estate Sale",
    "Magnolia Downsizing Sale",
}


def initialize_database(session: Session) -> None:
    """Clear legacy demo content left over from earlier builds."""

    existing_sale_titles = set(session.exec(select(Sale.title)).all())
    if not existing_sale_titles:
        return

    if not existing_sale_titles.issubset(LEGACY_DEMO_SALE_TITLES):
        return

    session.exec(delete(Task))
    session.exec(delete(Item))
    session.exec(delete(Sale))
    session.exec(delete(Category))
    session.commit()
