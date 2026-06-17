"""Reporting helpers for dashboard and sale views."""

from __future__ import annotations

from collections import defaultdict

from backend.core.models import Category, Item, ItemStatus, Sale, Task, TaskStatus
from backend.core.schemas import (
    CategoryBreakdown,
    CategoryRead,
    ItemRead,
    ReportMetrics,
    RoomBreakdown,
    SaleRead,
    SaleSummary,
    TaskRead,
    WorkspaceResponse,
)


def build_sale_summary(sale: Sale, items: list[Item], tasks: list[Task]) -> SaleSummary:
    """Build dashboard metrics for a single sale."""

    priced_items = [item for item in items if item.price is not None]
    sold_items = [item for item in items if item.status == ItemStatus.SOLD]
    pending_tasks = [task for task in tasks if task.status != TaskStatus.DONE]

    return SaleSummary(
        id=sale.id or 0,
        title=sale.title,
        address=sale.address,
        start_date=sale.start_date,
        end_date=sale.end_date,
        status=sale.status,
        item_count=len(items),
        priced_count=len(priced_items),
        sold_count=len(sold_items),
        pending_task_count=len(pending_tasks),
        estimated_revenue=round(sum(item.price or 0 for item in items), 2),
        realized_revenue=round(sum(item.price or 0 for item in sold_items), 2),
    )


def build_report_metrics(items: list[Item], categories: list[Category]) -> ReportMetrics:
    """Build report metrics for a sale workspace."""

    category_lookup = {category.id: category.name for category in categories}
    category_rollups: dict[str, dict[str, float | int]] = defaultdict(
        lambda: {"item_count": 0, "sold_count": 0, "listed_value": 0.0, "sold_value": 0.0}
    )
    room_rollups: dict[str, dict[str, float | int]] = defaultdict(
        lambda: {"item_count": 0, "listed_value": 0.0}
    )

    for item in items:
        category_name = category_lookup.get(item.category_id, "Uncategorized")
        room_name = item.room or "General"
        category_rollups[category_name]["item_count"] += 1
        category_rollups[category_name]["listed_value"] += item.price or 0.0
        room_rollups[room_name]["item_count"] += 1
        room_rollups[room_name]["listed_value"] += item.price or 0.0

        if item.status == ItemStatus.SOLD:
            category_rollups[category_name]["sold_count"] += 1
            category_rollups[category_name]["sold_value"] += item.price or 0.0

    category_breakdown = [
        CategoryBreakdown(
            category_name=category_name,
            item_count=int(values["item_count"]),
            sold_count=int(values["sold_count"]),
            listed_value=round(float(values["listed_value"]), 2),
            sold_value=round(float(values["sold_value"]), 2),
        )
        for category_name, values in sorted(
            category_rollups.items(),
            key=lambda entry: (float(entry[1]["sold_value"]), float(entry[1]["listed_value"])),
            reverse=True,
        )
    ]
    room_breakdown = [
        RoomBreakdown(
            room_name=room_name,
            item_count=int(values["item_count"]),
            listed_value=round(float(values["listed_value"]), 2),
        )
        for room_name, values in sorted(
            room_rollups.items(),
            key=lambda entry: float(entry[1]["listed_value"]),
            reverse=True,
        )
    ]

    total_items = len(items)
    priced_items = len([item for item in items if item.price is not None])
    sold_items = len([item for item in items if item.status == ItemStatus.SOLD])
    total_listed_value = round(sum(item.price or 0 for item in items), 2)
    total_sold_value = round(
        sum(item.price or 0 for item in items if item.status == ItemStatus.SOLD), 2
    )
    sell_through_rate = round((sold_items / total_items) * 100, 1) if total_items else 0.0

    return ReportMetrics(
        total_items=total_items,
        priced_items=priced_items,
        sold_items=sold_items,
        total_listed_value=total_listed_value,
        total_sold_value=total_sold_value,
        sell_through_rate=sell_through_rate,
        category_breakdown=category_breakdown,
        room_breakdown=room_breakdown,
    )


def build_workspace_response(
    sale: Sale,
    categories: list[Category],
    items: list[Item],
    tasks: list[Task],
) -> WorkspaceResponse:
    """Build the complete workspace payload consumed by the frontend."""

    return WorkspaceResponse(
        sale=SaleRead.model_validate(sale),
        summary=build_sale_summary(sale, items, tasks),
        categories=[CategoryRead.model_validate(category) for category in categories],
        items=[ItemRead.model_validate(item) for item in items],
        tasks=[TaskRead.model_validate(task) for task in tasks],
        report=build_report_metrics(items, categories),
    )
