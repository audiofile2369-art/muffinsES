"""Database models for sales management."""

from __future__ import annotations

from datetime import date, datetime, timezone
from enum import StrEnum

from sqlalchemy import DateTime, LargeBinary
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


class PaymentMethod(StrEnum):
    """How a buyer paid for an item (stored as these lowercase keys)."""

    CASH = "cash"
    CARD = "card"
    SQUARE = "square"
    CHECK = "check"
    VENMO = "venmo"
    ZELLE = "zelle"
    OTHER = "other"


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
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), nullable=False)


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
    # Existing databases get this column from `ensure_item_quantity_column`.
    quantity: int = Field(default=1, ge=1, sa_column_kwargs={"server_default": "1"})
    status: ItemStatus = Field(default=ItemStatus.AVAILABLE)
    notes: str = Field(default="")
    photo_url: str | None = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), nullable=False)


class Task(SQLModel, table=True):
    """Persisted sale preparation task record."""

    id: int | None = Field(default=None, primary_key=True)
    sale_id: int = Field(index=True, foreign_key="sale.id")
    title: str = Field(min_length=2, max_length=160)
    due_date: date | None = Field(default=None)
    status: TaskStatus = Field(default=TaskStatus.TODO)
    notes: str = Field(default="")


class ItemPhoto(SQLModel, table=True):
    """Small stored thumbnail for an item, kept in its own table.

    A separate table (rather than a column on Item) lets `create_all` add it
    to existing databases, which never gain new columns on old tables.
    """

    item_id: int = Field(primary_key=True, foreign_key="item.id")
    content_type: str = Field(max_length=40)
    data: bytes = Field(sa_type=LargeBinary, nullable=False)
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
        nullable=False,
    )


class ItemGalleryPhoto(SQLModel, table=True):
    """Extra photos for an item, beyond the main one stored in `ItemPhoto`.

    A new table (rather than changing `ItemPhoto`'s key) so `create_all` adds it
    to existing databases without touching any existing photo rows. The main
    photo always stays in `ItemPhoto`; "set as main" swaps bytes between the two
    tables in one transaction.
    """

    id: int | None = Field(default=None, primary_key=True)
    item_id: int = Field(index=True, foreign_key="item.id")
    content_type: str = Field(max_length=40)
    data: bytes = Field(sa_type=LargeBinary, nullable=False)
    position: int = Field(default=0)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
        nullable=False,
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
        nullable=False,
    )


class ItemSaleEvent(SQLModel, table=True):
    """One sale of some units of an item: the single source of truth for what sold.

    A new table (rather than new columns on `item`) so `create_all` adds it to
    existing databases without altering or rewriting any existing row. Each
    "Sell item" adds one row; Undo removes exactly that row.

    `amount` is the total money received for the `quantity` units in this sale
    (not a per-unit price). `sold_at` is None only for a legacy sale recorded
    afterwards (an item marked sold before sales were recorded).
    `status_before` is the item's status before this sale, restored by Undo.
    """

    id: int | None = Field(default=None, primary_key=True)
    item_id: int = Field(index=True, foreign_key="item.id")
    quantity: int = Field(ge=1)
    amount: float = Field(default=0.0, ge=0)
    payment_method: str | None = Field(default=None, max_length=20)
    status_before: str = Field(default=ItemStatus.AVAILABLE.value, max_length=20)
    sold_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True), nullable=True)
    # The customer sale (checkout) this line belongs to; None for sales recorded
    # before checkouts existed. Added to existing databases by
    # `ensure_item_sale_event_order_column` (a nullable column, no rewrite) and
    # deliberately without a database foreign key so older code deleting these
    # rows can never be blocked by it.
    order_id: int | None = Field(default=None, index=True)


class CustomerOrder(SQLModel, table=True):
    """One sale to one customer at an estate sale (a checkout of one or more items).

    Its lines are the `ItemSaleEvent` rows with this `order_id`; those rows stay
    the single source of truth for what sold and the money received (their
    `amount`s add up exactly to `total`). `lines_json` is a snapshot of the cart
    as checked out (titles, prices, discounts) so a voided order can still be
    shown. Voiding deletes the lines (restoring the items, as Undo does) and
    sets `voided_at`.
    """

    __tablename__ = "customer_order"

    id: int | None = Field(default=None, primary_key=True)
    sale_id: int = Field(index=True, foreign_key="sale.id")
    subtotal: float = Field(default=0.0, ge=0)
    discount_total: float = Field(default=0.0)
    total: float = Field(default=0.0, ge=0)
    payment_method: str = Field(max_length=20)
    note: str = Field(default="", max_length=500)
    lines_json: str = Field(default="[]")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_type=DateTime(timezone=True),
        nullable=False,
    )
    voided_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True), nullable=True)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SquarePayment(SQLModel, table=True):
    """One attempt to take a customer's payment through Square (a "pending Square sale").

    The cart (`cart_json`, a CheckoutRequest without the payment method) waits
    here until Square confirms the money; only then is the `customer_order`
    created, through the same checkout code as any other sale, and `order_id`
    set. Nothing is marked sold for a payment that fails or is canceled.

    `kind` is how the money is taken: `terminal` (a Square Terminal device),
    `pos_app` (the Square Point of Sale app on this phone or tablet) or
    `payment_link` (a Square-hosted checkout page / QR). `square_checkout_id` is
    the Terminal checkout id or the payment link id. `status` is one of
    pending, completed, canceled, failed, refunded, or conflict (Square took the
    money but the items had been sold on another device meanwhile; refund it).
    A new table: `create_all` adds it without touching existing rows.
    """

    __tablename__ = "square_payment"

    id: int | None = Field(default=None, primary_key=True)
    sale_id: int = Field(index=True)
    order_id: int | None = Field(default=None, index=True)
    kind: str = Field(max_length=20)
    status: str = Field(default="pending", max_length=20, index=True)
    amount_cents: int = Field(ge=0)
    currency: str = Field(default="USD", max_length=3)
    cart_json: str = Field(default="{}")
    client_key: str = Field(max_length=64, unique=True)
    idempotency_key: str = Field(max_length=64)
    square_checkout_id: str | None = Field(default=None, max_length=255)
    square_order_id: str | None = Field(default=None, max_length=255)
    square_payment_id: str | None = Field(default=None, max_length=255)
    square_refund_id: str | None = Field(default=None, max_length=255)
    device_id: str | None = Field(default=None, max_length=255)
    link_url: str | None = Field(default=None, max_length=1000)
    raw_last_status: str = Field(default="", max_length=60)
    message: str = Field(default="", max_length=1000)
    created_at: datetime = Field(default_factory=_utcnow, sa_type=DateTime(timezone=True), nullable=False)
    updated_at: datetime = Field(default_factory=_utcnow, sa_type=DateTime(timezone=True), nullable=False)


class SquareDevice(SQLModel, table=True):
    """A Square Terminal paired with this app (or a pairing code still waiting to be typed in).

    `device_id` is None until the cashier enters `code` on the Terminal and
    Square reports the code as PAIRED.
    """

    __tablename__ = "square_device"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(max_length=80)
    device_id: str | None = Field(default=None, max_length=255, index=True)
    device_code_id: str | None = Field(default=None, max_length=255)
    code: str | None = Field(default=None, max_length=20)
    code_status: str = Field(default="UNPAIRED", max_length=20)
    pair_by: str | None = Field(default=None, max_length=40)
    location_id: str | None = Field(default=None, max_length=255)
    created_at: datetime = Field(default_factory=_utcnow, sa_type=DateTime(timezone=True), nullable=False)
    last_used_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True), nullable=True)
