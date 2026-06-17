"""Database models for sales management."""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum

from sqlmodel import Field, SQLModel


class SaleStatus(StrEnum):
    """Supported lifecycle states for an estate sale."""

    PLANNING = "planning"
    READY = "ready"
    LIVE = "live"
    CLOSED = "closed"
    ARCHIVED = "archived"


class ItemStatus(StrEnum):
    """Supported lifecycle states for an item."""

    AVAILABLE = "available"
    SOLD = "sold"
    DISCOUNTED = "discounted"
    RESERVED = "reserved"
    DONATED = "donated"
    REMOVED = "removed"


class TaskStatus(StrEnum):
    """Supported workflow states for a task."""

    TODO = "todo"
    IN_PROGRESS = "in_progress"
    DONE = "done"


class Sale(SQLModel, table=True):
    """Persisted estate sale record."""

    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(index=True, min_length=2, max_length=120)
    address: str = Field(default="", max_length=240)
    start_date: date
    end_date: date
    status: SaleStatus = Field(default=SaleStatus.PLANNING)
    notes: str = Field(default="")
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class Category(SQLModel, table=True):
    """Persisted item category record."""

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True, min_length=2, max_length=80)
    color: str = Field(default="#7c3aed", min_length=4, max_length=12)
    sort_order: int = Field(default=0)


class Item(SQLModel, table=True):
    """Persisted inventory item record."""

    id: int | None = Field(default=None, primary_key=True)
    sale_id: int = Field(index=True, foreign_key="sale.id")
    category_id: int | None = Field(default=None, foreign_key="category.id")
    title: str = Field(index=True, min_length=2, max_length=160)
    description: str = Field(default="")
    room: str = Field(default="General", max_length=80)
    condition: str = Field(default="Good", max_length=80)
    price: float | None = Field(default=None, ge=0)
    status: ItemStatus = Field(default=ItemStatus.AVAILABLE)
    notes: str = Field(default="")
    photo_url: str | None = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class Task(SQLModel, table=True):
    """Persisted sale preparation task record."""

    id: int | None = Field(default=None, primary_key=True)
    sale_id: int = Field(index=True, foreign_key="sale.id")
    title: str = Field(min_length=2, max_length=160)
    due_date: date | None = Field(default=None)
    status: TaskStatus = Field(default=TaskStatus.TODO)
    notes: str = Field(default="")
