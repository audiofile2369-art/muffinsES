"""What has sold, derived from `ItemSaleEvent` rows (the single source of truth).

Rules (also used by reports and totals):

* `sold_quantity`: units sold. An item whose status is `sold` counts as fully
  sold (all `quantity` units) even when no sale rows exist -- that is how items
  marked sold before sales were recorded (or by an older app version) keep
  counting, with no data rewrite.
* `sold_total`: total money received = sum of each sale's `amount`, plus, for a
  `sold` item, any units with no recorded sale at the listed price.
* remaining units = quantity - sold_quantity (never below 0); a partly sold lot
  stays `available` and only its unsold units count toward remaining value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlmodel import Session, select

from backend.core.models import Item, ItemSaleEvent, ItemStatus

STILL_FOR_SALE = {ItemStatus.AVAILABLE, ItemStatus.DISCOUNTED, ItemStatus.RESERVED}


@dataclass
class SoldState:
    sold_quantity: int = 0
    sold_total: float | None = None
    sold_at: datetime | None = None
    payment_method: str | None = None
    # (payment_method or None, amount) per recorded sale, plus one for any unrecorded legacy portion.
    payments: list[tuple[str | None, float]] = field(default_factory=list)

    @property
    def unrecorded(self) -> bool:
        return any(method is None for method, _ in self.payments)


def as_utc(value: datetime | None) -> datetime | None:
    """Sale times are stored in UTC; SQLite hands them back without a zone, so add it back."""

    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def load_sale_events(session: Session, item_ids: list[int]) -> dict[int, list[ItemSaleEvent]]:
    """All sale rows for these items in one query, oldest first."""

    if not item_ids:
        return {}
    rows = session.exec(
        select(ItemSaleEvent)
        .where(ItemSaleEvent.item_id.in_(item_ids))
        .order_by(ItemSaleEvent.id)
    ).all()
    grouped: dict[int, list[ItemSaleEvent]] = {}
    for row in rows:
        grouped.setdefault(row.item_id, []).append(row)
    return grouped


def recorded_units(events: list[ItemSaleEvent]) -> int:
    return sum(event.quantity for event in events)


def sold_state(item: Item, events: list[ItemSaleEvent]) -> SoldState:
    quantity = item.quantity or 1
    recorded = recorded_units(events)
    payments: list[tuple[str | None, float]] = [(event.payment_method, event.amount) for event in events]
    total = sum(event.amount for event in events)
    if item.status == ItemStatus.SOLD:
        sold_quantity = quantity
        unrecorded_units = max(0, quantity - recorded)
        if unrecorded_units:
            legacy_amount = (item.price or 0.0) * unrecorded_units
            total += legacy_amount
            payments.append((None, legacy_amount))
    else:
        sold_quantity = min(recorded, quantity)
    dated = [event for event in events if event.sold_at is not None]
    latest = events[-1] if events else None
    return SoldState(
        sold_quantity=sold_quantity,
        sold_total=round(total, 2) if sold_quantity or events else None,
        sold_at=as_utc(max((event.sold_at for event in dated), default=None)),
        payment_method=latest.payment_method if latest else None,
        payments=payments,
    )


def remaining_units(item: Item, events: list[ItemSaleEvent]) -> int:
    return max(0, (item.quantity or 1) - sold_state(item, events).sold_quantity)


def sold_fields(item: Item, events: list[ItemSaleEvent]) -> dict[str, object]:
    """Extra ItemRead fields for an item."""

    state = sold_state(item, events)
    return {
        "sold_quantity": state.sold_quantity,
        "sold_total": state.sold_total,
        "sold_at": state.sold_at,
        "payment_method": state.payment_method,
        "sale_events": [
            {
                "id": event.id,
                "quantity": event.quantity,
                "amount": event.amount,
                "payment_method": event.payment_method,
                "sold_at": as_utc(event.sold_at),
            }
            for event in events
        ],
    }
