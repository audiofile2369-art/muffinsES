"""Price math for a customer sale (checkout): line prices, discounts and allocation.

All money is worked in whole cents so totals never drift:

* line gross = unit price x quantity (rounded to cents)
* line net = gross - line discount (a $ amount, never below 0)
* items total = sum of line nets
* order discount = a $ amount, a percent of the items total, or "set total"
  (the agreed final total; the discount is whatever closes the gap). It is
  capped so the total is never negative, and "set total" may not exceed the
  items total.
* the order discount is spread across lines in proportion to their net, so each
  line's `amount` is the money actually received for it; the lines add up
  exactly to the total, with the rounding remainder on the last line.

The frontend mirrors this in frontend/src/checkout.ts so the total shown is the
total the server records.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


class CheckoutError(ValueError):
    """The requested prices or discounts make no sense (HTTP 422)."""


def round_half_up(value: float) -> int:
    """Round like JavaScript's Math.round so the browser and server agree to the cent."""

    return int(math.floor(value + 0.5))


def to_cents(value: float) -> int:
    return round_half_up(value * 100)


def from_cents(cents: int) -> float:
    return round(cents / 100, 2)


@dataclass
class PricedLine:
    quantity: int
    unit_price: float
    line_discount: float
    gross_cents: int
    net_cents: int
    amount_cents: int = 0


@dataclass
class PricedOrder:
    lines: list[PricedLine]
    subtotal_cents: int
    items_total_cents: int
    order_discount_cents: int
    total_cents: int

    @property
    def discount_total_cents(self) -> int:
        return self.subtotal_cents - self.total_cents


def price_order(
    lines: list[tuple[int, float, float]],
    discount_amount: float | None = None,
    discount_percent: float | None = None,
    set_total: float | None = None,
) -> PricedOrder:
    """Price `(quantity, unit_price, line_discount)` lines and allocate the order discount."""

    if sum(value is not None for value in (discount_amount, discount_percent, set_total)) > 1:
        raise CheckoutError("Use only one sale discount: an amount, a percent, or a set total.")
    priced: list[PricedLine] = []
    for quantity, unit_price, line_discount in lines:
        gross = to_cents(unit_price * quantity)
        discount = min(max(to_cents(line_discount), 0), gross)
        priced.append(PricedLine(quantity, unit_price, line_discount, gross, gross - discount))
    subtotal = sum(line.gross_cents for line in priced)
    items_total = sum(line.net_cents for line in priced)

    if set_total is not None:
        target = to_cents(set_total)
        if target > items_total:
            raise CheckoutError("The total can't be more than the items add up to. Change an item's price instead.")
        order_discount = items_total - target
    elif discount_percent is not None:
        order_discount = round_half_up(items_total * discount_percent / 100)
    elif discount_amount is not None:
        order_discount = to_cents(discount_amount)
    else:
        order_discount = 0
    order_discount = min(max(order_discount, 0), items_total)
    total = items_total - order_discount

    allocate(priced, total, items_total)
    return PricedOrder(priced, subtotal, items_total, order_discount, total)


def allocate(lines: list[PricedLine], total_cents: int, items_total_cents: int) -> None:
    """Set each line's `amount_cents` in proportion to its net; they sum exactly to the total."""

    if not lines:
        return
    if items_total_cents <= 0:
        for line in lines:
            line.amount_cents = 0
        lines[-1].amount_cents = total_cents
        return
    shares = [round_half_up(total_cents * line.net_cents / items_total_cents) for line in lines[:-1]]
    if sum(shares) > total_cents:  # rounding pushed the earlier lines over: round down instead
        shares = [total_cents * line.net_cents // items_total_cents for line in lines[:-1]]
    for line, share in zip(lines[:-1], shares):
        line.amount_cents = share
    lines[-1].amount_cents = total_cents - sum(shares)
