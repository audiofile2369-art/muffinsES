"""API request and response schemas."""

from __future__ import annotations

from datetime import date

from sqlmodel import Field, SQLModel

from backend.core.models import ItemStatus, SaleStatus, TaskStatus


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
    status: ItemStatus = Field(default=ItemStatus.AVAILABLE)
    notes: str = Field(default="")
    photo_url: str | None = Field(default=None, max_length=500)


class BulkItemUpdate(SQLModel):
    """Payload for applying a shared update to many items."""

    item_ids: list[int]
    status: ItemStatus | None = None
    category_id: int | None = None


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
    status: ItemStatus
    notes: str
    photo_url: str | None


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


class WorkspaceResponse(SQLModel):
    """Workspace payload for a single sale."""

    sale: SaleRead
    summary: SaleSummary
    categories: list[CategoryRead]
    items: list[ItemRead]
    tasks: list[TaskRead]
    report: ReportMetrics
