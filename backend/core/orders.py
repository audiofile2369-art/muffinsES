"""Customer sales (checkouts): selling a cart of items to one customer, and voiding it.

A `CustomerOrder` groups the `ItemSaleEvent` rows it created (via their
`order_id`). Those rows remain the single source of truth for what sold and the
money received, so reports, totals and the item lists need no changes: a voided
order's rows are gone, exactly as if each line had been undone.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete, update
from sqlmodel import Session, select

from backend.core.checkout import CheckoutError, from_cents, price_order
from backend.core.models import CustomerOrder, Item, ItemSaleEvent, ItemStatus
from backend.core.schemas import CheckoutRequest, CheckoutUnavailable, OrderLineRead, OrderRead
from backend.core.selling import as_utc, load_sale_events, recorded_units, remaining_units


class CheckoutConflict(Exception):
    """Some cart lines can no longer be sold as asked (HTTP 409)."""

    def __init__(self, unavailable: list[CheckoutUnavailable]) -> None:
        super().__init__("Some items are no longer available.")
        self.unavailable = unavailable


@dataclass
class SellLine:
    item_id: int
    quantity: int
    unit_price: float | None
    line_discount: float = 0.0


def lock_item_row(session: Session, item_id: int) -> None:
    """Take the item row lock for this transaction (a no-op UPDATE).

    Postgres makes a second tablet selling the same item wait here until the
    first commits, and SQLite serialises writers, so the remaining-quantity
    check that follows always sees every earlier sale: no overselling.
    """

    session.exec(update(Item).where(Item.id == item_id).values(quantity=Item.quantity))


def restored_status(status_before: str | None) -> ItemStatus:
    valid = {status.value for status in ItemStatus} - {ItemStatus.SOLD.value}
    return ItemStatus(status_before) if status_before in valid else ItemStatus.AVAILABLE


def record_order(
    session: Session,
    sale_id: int,
    lines: list[SellLine],
    payment_method: str,
    *,
    discount_amount: float | None = None,
    discount_percent: float | None = None,
    set_total: float | None = None,
    note: str = "",
    sold_at: datetime | None = None,
    check_sale: bool = True,
) -> CustomerOrder:
    """Sell every line or nothing; the caller commits (or rolls back on an exception).

    Item rows are locked in ascending id order, so two tablets selling
    overlapping carts wait for each other instead of deadlocking, and the
    remaining-quantity checks see every earlier sale.
    """

    if not lines:
        raise CheckoutError("The cart is empty.")
    item_ids = [line.item_id for line in lines]
    if len(set(item_ids)) != len(item_ids):
        raise CheckoutError("An item is in the cart twice. Change its quantity instead.")
    for item_id in sorted(item_ids):
        lock_item_row(session, item_id)
    items = {
        item.id: item
        for item in session.exec(
            select(Item).where(Item.id.in_(item_ids)).execution_options(populate_existing=True)
        ).all()
    }
    if check_sale:
        foreign = [item for item in items.values() if item.sale_id != sale_id]
        if foreign:
            raise CheckoutError(f'"{foreign[0].title}" belongs to a different estate sale.')
    events = load_sale_events(session, item_ids)

    unavailable: list[CheckoutUnavailable] = []
    for line in lines:
        item = items.get(line.item_id)
        if item is None:
            unavailable.append(
                CheckoutUnavailable(item_id=line.item_id, title="Deleted item", remaining=0, reason="deleted")
            )
            continue
        remaining = remaining_units(item, events.get(item.id, []))
        if line.quantity > remaining:
            unavailable.append(
                CheckoutUnavailable(
                    item_id=item.id,
                    title=item.title,
                    remaining=remaining,
                    reason="sold" if remaining == 0 else "not_enough",
                )
            )
    if unavailable:
        raise CheckoutConflict(unavailable)

    unit_prices = [
        line.unit_price if line.unit_price is not None else (items[line.item_id].price or 0.0) for line in lines
    ]
    priced = price_order(
        [(line.quantity, unit_price, line.line_discount) for line, unit_price in zip(lines, unit_prices)],
        discount_amount=discount_amount,
        discount_percent=discount_percent,
        set_total=set_total,
    )
    when = sold_at or datetime.now(timezone.utc)
    order = CustomerOrder(
        sale_id=sale_id,
        subtotal=from_cents(priced.subtotal_cents),
        discount_total=from_cents(priced.discount_total_cents),
        total=from_cents(priced.total_cents),
        payment_method=payment_method,
        note=note.strip(),
        created_at=when,
    )
    session.add(order)
    session.flush()

    created: list[ItemSaleEvent] = []
    for line, priced_line in zip(lines, priced.lines):
        item = items[line.item_id]
        item_events = events.get(item.id, [])
        event = ItemSaleEvent(
            item_id=item.id,
            quantity=line.quantity,
            amount=from_cents(priced_line.amount_cents),
            payment_method=payment_method,
            status_before=item.status.value if item.status != ItemStatus.SOLD else ItemStatus.AVAILABLE.value,
            sold_at=when,
            order_id=order.id,
        )
        session.add(event)
        created.append(event)
        if recorded_units(item_events) + line.quantity >= (item.quantity or 1):
            item.status = ItemStatus.SOLD
            session.add(item)
    session.flush()

    order.lines_json = json.dumps(
        [
            {
                "item_id": item_id,
                "title": items[item_id].title,
                "quantity": priced_line.quantity,
                "unit_price": round(priced_line.unit_price, 2),
                "list_price": items[item_id].price,
                "line_discount": from_cents(priced_line.gross_cents - priced_line.net_cents),
                "amount": from_cents(priced_line.amount_cents),
                "event_id": event.id,
            }
            for item_id, priced_line, event in zip(item_ids, priced.lines, created)
        ]
    )
    session.add(order)
    return order


def checkout(session: Session, sale_id: int, payload: CheckoutRequest) -> CustomerOrder:
    return record_order(
        session,
        sale_id,
        [SellLine(line.item_id, line.quantity, line.unit_price, line.line_discount) for line in payload.lines],
        payload.payment_method.value,
        discount_amount=payload.discount_amount,
        discount_percent=payload.discount_percent,
        set_total=payload.set_total,
        note=payload.note,
    )


def void_order(session: Session, order: CustomerOrder) -> None:
    """Undo every line of the order (as Undo does per item) and mark it voided. Idempotent."""

    session.exec(update(CustomerOrder).where(CustomerOrder.id == order.id).values(note=CustomerOrder.note))
    session.refresh(order)
    if order.voided_at is not None:
        return
    events = session.exec(select(ItemSaleEvent).where(ItemSaleEvent.order_id == order.id)).all()
    for item_id in sorted({event.item_id for event in events}):
        lock_item_row(session, item_id)
    items = {
        item.id: item
        for item in session.exec(
            select(Item)
            .where(Item.id.in_([event.item_id for event in events]))
            .execution_options(populate_existing=True)
        ).all()
    }
    for event in events:
        item = items.get(event.item_id)
        session.delete(event)
        if item is not None and item.status == ItemStatus.SOLD:
            item.status = restored_status(event.status_before)
            session.add(item)
    order.voided_at = datetime.now(timezone.utc)
    session.add(order)


def forget_empty_orders(session: Session, order_ids: set[int]) -> None:
    """Remove orders whose every line was undone some other way (Undo, status change, delete).

    An undone sale never happened, so it should not linger in Recent sales.
    Voided orders are kept (they are an explicit record of a void).
    """

    order_ids = {order_id for order_id in order_ids if order_id is not None}
    if not order_ids:
        return
    session.flush()
    live = set(session.exec(select(ItemSaleEvent.order_id).where(ItemSaleEvent.order_id.in_(order_ids))).all())
    empty = [order_id for order_id in order_ids if order_id not in live]
    if empty:
        session.exec(
            delete(CustomerOrder).where(CustomerOrder.id.in_(empty), CustomerOrder.voided_at.is_(None))
        )


def delete_sale_events(session: Session, *conditions: object) -> None:
    """Delete the sale rows matching `conditions`, then drop any order left empty."""

    order_ids = set(
        session.exec(
            select(ItemSaleEvent.order_id).where(*conditions, ItemSaleEvent.order_id.is_not(None))
        ).all()
    )
    session.exec(delete(ItemSaleEvent).where(*conditions))
    forget_empty_orders(session, order_ids)


def build_order_reads(session: Session, orders: list[CustomerOrder]) -> list[OrderRead]:
    """Serialize orders with their lines in one extra query."""

    order_ids = [order.id for order in orders if order.id is not None]
    live: dict[int, ItemSaleEvent] = {}
    if order_ids:
        for event in session.exec(select(ItemSaleEvent).where(ItemSaleEvent.order_id.in_(order_ids))).all():
            if event.id is not None:
                live[event.id] = event
    reads: list[OrderRead] = []
    for order in orders:
        try:
            snapshot = json.loads(order.lines_json or "[]")
        except ValueError:
            snapshot = []
        lines = [
            OrderLineRead(**line, returned=order.voided_at is not None or line.get("event_id") not in live)
            for line in snapshot
        ]
        received = 0.0 if order.voided_at is not None else sum(
            live[line.event_id].amount for line in lines if line.event_id in live
        )
        reads.append(
            OrderRead(
                id=order.id or 0,
                sale_id=order.sale_id,
                subtotal=order.subtotal,
                discount_total=order.discount_total,
                total=order.total,
                received_total=round(received, 2),
                item_count=sum(line.quantity for line in lines),
                payment_method=order.payment_method,
                note=order.note,
                created_at=as_utc(order.created_at) or order.created_at,
                voided_at=as_utc(order.voided_at),
                voided=order.voided_at is not None,
                lines=lines,
            )
        )
    return reads

