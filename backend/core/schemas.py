"""API request and response schemas."""

from __future__ import annotations

from datetime import date, datetime

from sqlmodel import Field, SQLModel

from backend.core.models import ItemStatus, PaymentMethod, SaleStatus, TaskStatus


class SaleCreate(SQLModel):
    """Payload for creating a sale."""

    title: str = Field(min_length=2, max_length=120)
    address: str = Field(default="", max_length=240)
    start_date: date
    end_date: date
    status: SaleStatus = Field(default=SaleStatus.PLANNING)
    notes: str = Field(default="")


class SaleUpdate(SQLModel):
    """Payload for updating a sale."""

    title: str = Field(min_length=2, max_length=120)
    address: str = Field(default="", max_length=240)
    start_date: date
    end_date: date
    status: SaleStatus
    notes: str = Field(default="")


class SaleRead(SQLModel):
    """Sale record returned to the UI."""

    id: int
    title: str
    address: str
    start_date: date
    end_date: date
    status: SaleStatus
    notes: str


class SaleSummary(SQLModel):
    """Summary metrics shown in the dashboard."""

    id: int
    title: str
    address: str
    start_date: date
    end_date: date
    status: SaleStatus
    item_count: int
    priced_count: int
    sold_count: int
    pending_task_count: int
    estimated_revenue: float
    realized_revenue: float


class DashboardResponse(SQLModel):
    """Dashboard payload listing all sales."""

    sales: list[SaleSummary]


class CategoryCreate(SQLModel):
    """Payload for creating a category."""

    name: str = Field(min_length=2, max_length=80)
    color: str = Field(default="#7c3aed", min_length=4, max_length=12)
    sort_order: int = Field(default=0)


class CategoryUpdate(SQLModel):
    """Payload for updating a category."""

    name: str = Field(min_length=2, max_length=80)
    color: str = Field(default="#7c3aed", min_length=4, max_length=12)
    sort_order: int = Field(default=0)


class CategoryRead(SQLModel):
    """Category returned to the UI."""

    id: int
    name: str
    color: str
    sort_order: int


class ItemCreate(SQLModel):
    """Payload for creating an inventory item."""

    sale_id: int
    category_id: int | None = None
    title: str = Field(min_length=2, max_length=160)
    description: str = Field(default="")
    room: str = Field(default="General", max_length=80)
    condition: str = Field(default="Good", max_length=80)
    price: float | None = Field(default=None, ge=0)
    quantity: int = Field(default=1, ge=1)
    status: ItemStatus = Field(default=ItemStatus.AVAILABLE)
    notes: str = Field(default="")
    photo_url: str | None = Field(default=None, max_length=500)


class ItemUpdate(SQLModel):
    """Payload for updating an inventory item."""

    category_id: int | None = None
    title: str = Field(min_length=2, max_length=160)
    description: str = Field(default="")
    room: str = Field(default="General", max_length=80)
    condition: str = Field(default="Good", max_length=80)
    price: float | None = Field(default=None, ge=0)
    quantity: int = Field(default=1, ge=1)
    status: ItemStatus = Field(default=ItemStatus.AVAILABLE)
    notes: str = Field(default="")
    photo_url: str | None = Field(default=None, max_length=500)


class ItemQuantityIncrement(SQLModel):
    """Payload for adding more of an item that is already listed."""

    amount: int = Field(default=1, ge=1, le=10000)


class ItemStatusUpdate(SQLModel):
    """Payload for changing only an item's status."""

    status: ItemStatus


class BulkItemUpdate(SQLModel):
    """Payload for applying a shared update to many items."""

    item_ids: list[int]
    status: ItemStatus | None = None
    category_id: int | None = None


class ItemSell(SQLModel):
    """Payload for selling some (or all remaining) units of an item."""

    quantity: int = Field(default=1, ge=1, le=10000)
    # Price per unit actually charged; defaults to the listed price. Stored as a total.
    unit_price: float | None = Field(default=None, ge=0)
    payment_method: PaymentMethod
    # Only for Undo of an "unsell": put a removed sale back with its original time.
    sold_at: datetime | None = None


class ItemUnsell(SQLModel):
    """Payload for undoing one recorded sale, or (no id) every sale of the item."""

    event_id: int | None = None


class ItemPaymentMethodUpdate(SQLModel):
    """Payload for correcting how a sale was paid."""

    payment_method: PaymentMethod
    # Which sale to change; omitted = the latest (or the legacy, unrecorded sale).
    event_id: int | None = None


class ItemSaleEventRead(SQLModel):
    """One recorded sale of an item. `amount` = total received for `quantity` units."""

    id: int
    quantity: int
    amount: float
    payment_method: str | None
    sold_at: datetime | None
    # The customer sale this was part of (None for sales recorded before checkouts).
    order_id: int | None = None


class CheckoutLine(SQLModel):
    """One cart line: `quantity` units of an item at `unit_price` each, less a $ line discount."""

    item_id: int
    quantity: int = Field(default=1, ge=1, le=10000)
    # Price per unit agreed with the customer; defaults to the listed price.
    unit_price: float | None = Field(default=None, ge=0, le=1_000_000)
    line_discount: float = Field(default=0.0, ge=0, le=10_000_000)


class CheckoutRequest(SQLModel):
    """Payload for selling a cart of items to one customer, all or nothing.

    At most one sale-wide discount: `discount_amount` ($), `discount_percent`
    (0-100) or `set_total` (the agreed final total). Totals are worked out by the
    server; the browser's own total is only for display.
    """

    lines: list[CheckoutLine] = Field(min_length=1, max_length=500)
    payment_method: PaymentMethod
    discount_amount: float | None = Field(default=None, ge=0, le=10_000_000)
    discount_percent: float | None = Field(default=None, ge=0, le=100)
    set_total: float | None = Field(default=None, ge=0, le=10_000_000)
    note: str = Field(default="", max_length=500)


class OrderLineRead(SQLModel):
    """One line of a customer sale, as checked out.

    `amount` is the money received for the line after every discount.
    `returned` means that line's sale has since been undone (Undo, the item
    set back to available, the item deleted, or the whole sale voided).
    """

    item_id: int
    title: str
    quantity: int
    unit_price: float
    list_price: float | None = None
    line_discount: float = 0.0
    amount: float
    event_id: int | None = None
    returned: bool = False


class OrderRead(SQLModel):
    """One sale to one customer (a checkout).

    `total` is what was charged at checkout; `received_total` is the money still
    counted as received (lines not returned; 0 once voided).
    """

    id: int
    sale_id: int
    subtotal: float
    discount_total: float
    total: float
    received_total: float
    item_count: int
    payment_method: str
    note: str
    created_at: datetime
    voided_at: datetime | None = None
    voided: bool = False
    lines: list[OrderLineRead] = Field(default_factory=list)


class CheckoutUnavailable(SQLModel):
    """A cart line that can no longer be sold as asked (sent with a 409)."""

    item_id: int
    title: str
    remaining: int
    reason: str


class ItemRead(SQLModel):
    """Inventory item returned to the UI."""

    id: int
    sale_id: int
    category_id: int | None
    title: str
    description: str
    room: str
    condition: str
    price: float | None
    quantity: int = 1
    status: ItemStatus
    notes: str
    photo_url: str | None
    photo_version: str | None = None
    photo_count: int = 0
    # Selling (all derived from ItemSaleEvent rows; see backend/core/selling.py).
    sold_quantity: int = 0
    # Total money received for all sold units (None when nothing is sold).
    sold_total: float | None = None
    sold_at: datetime | None = None
    payment_method: str | None = None
    sale_events: list[ItemSaleEventRead] = Field(default_factory=list)


class ItemPhotoRead(SQLModel):
    """One stored photo of an item (no image bytes).

    `id` is None for the main photo (served from `/items/{id}/photo`); extra
    photos are served from `/items/{id}/photos/{photo_id}`.
    """

    id: int | None
    is_main: bool
    version: str


class ItemWithSale(ItemRead):
    """Item returned by the all-items view, with its sale and category names."""

    sale_title: str
    category_name: str | None = None
    created_at: datetime


class TaskCreate(SQLModel):
    """Payload for creating a task."""

    sale_id: int
    title: str = Field(min_length=2, max_length=160)
    due_date: date | None = None
    status: TaskStatus = Field(default=TaskStatus.TODO)
    notes: str = Field(default="")


class TaskUpdate(SQLModel):
    """Payload for updating a task."""

    title: str = Field(min_length=2, max_length=160)
    due_date: date | None = None
    status: TaskStatus
    notes: str = Field(default="")


class TaskRead(SQLModel):
    """Task returned to the UI."""

    id: int
    sale_id: int
    title: str
    due_date: date | None
    status: TaskStatus
    notes: str


class CategoryBreakdown(SQLModel):
    """Aggregated metrics for a category."""

    category_name: str
    item_count: int
    sold_count: int
    listed_value: float
    sold_value: float


class RoomBreakdown(SQLModel):
    """Aggregated metrics for a room."""

    room_name: str
    item_count: int
    listed_value: float


class PaymentBreakdown(SQLModel):
    """Money received per payment method (None = not recorded, e.g. older sales)."""

    payment_method: str | None
    sale_count: int
    total: float


class ReportMetrics(SQLModel):
    """Sales reporting payload."""

    total_items: int
    priced_items: int
    sold_items: int
    total_listed_value: float
    total_sold_value: float
    sell_through_rate: float
    category_breakdown: list[CategoryBreakdown]
    room_breakdown: list[RoomBreakdown]
    # Listed price x units not yet sold, for items still for sale.
    total_remaining_value: float = 0.0
    sold_units: int = 0
    payment_breakdown: list[PaymentBreakdown] = Field(default_factory=list)


class WorkspaceResponse(SQLModel):
    """Workspace payload for a single sale."""

    sale: SaleRead
    summary: SaleSummary
    categories: list[CategoryRead]
    items: list[ItemRead]
    tasks: list[TaskRead]
    report: ReportMetrics


class PhotoSearchMatch(SQLModel):
    """One saved item found in a search photo."""

    item: ItemWithSale
    confidence: str
    reason: str = ""


class PhotoSearchResponse(SQLModel):
    """Result of searching the inventory by photo."""

    summary: str
    matches: list[PhotoSearchMatch]
    candidates_considered: int


class PricingEstimateResponse(SQLModel):
    """AI pricing estimate returned from an item photo."""

    suggested_title: str
    suggested_category: str
    suggested_room: str
    suggested_description: str = ""
    suggested_condition: str = ""
    estimated_price: float | None
    low_estimate: float | None
    high_estimate: float | None
    reasoning: str
    follow_up_questions: list[str]
