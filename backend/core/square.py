"""Taking a customer's payment through Square, then recording the sale.

Three ways to take the money, behind one "Charge with Square" flow:

* `terminal`     -- a paired Square Terminal (Terminal API: `POST /v2/terminals/checkouts`,
                    polled with `GET /v2/terminals/checkouts/{id}`).
* `pos_app`      -- the Square Point of Sale app on this phone/tablet (Point of Sale API
                    deep link built by the browser; Square calls back to `/square/callback`
                    and the transaction is verified here with `GET /v2/orders/{id}`).
* `payment_link` -- a Square-hosted checkout page (`POST /v2/online-checkout/payment-links`),
                    polled through its order (`GET /v2/orders/{id}`).

The cart waits in a `square_payment` row until Square confirms the money; only
then is the sale recorded, through the same `checkout()` as every other sale.
Every amount is checked server-side against the payment Square reports
(`GET /v2/payments/{id}`); nothing the browser sends back is trusted.

Configuration comes from the environment (never logged or returned):
SQUARE_ACCESS_TOKEN (or a gitignored `square token.txt` for local runs),
SQUARE_ENVIRONMENT (production | sandbox), SQUARE_APPLICATION_ID (needed for the
POS app), SQUARE_LOCATION_ID (optional; otherwise the first ACTIVE location).

SQUARE_FAKE=1 swaps Square for an in-memory fake (see FakeSquare) for local
development. It is refused on Vercel and on any non-SQLite database, so it can
never be on in production.
"""

from __future__ import annotations

import json
import os
import random
import string
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import update
from sqlmodel import Field, Session, SQLModel, select

from backend.config.database import get_db
from backend.config.settings import get_logger, get_settings
from backend.core.checkout import CheckoutError, from_cents, to_cents
from backend.core.models import CustomerOrder, PaymentMethod, Sale, SquareDevice, SquarePayment
from backend.core.orders import CheckoutConflict, build_order_reads, checkout, void_order
from backend.core.schemas import CheckoutRequest, OrderRead

LOGGER = get_logger(__name__)

SQUARE_API_VERSION = "2025-01-23"
SQUARE_TIMEOUT_SECONDS = 20.0
SQUARE_BASE_URLS = {
    "production": "https://connect.squareup.com",
    "sandbox": "https://connect.squareupsandbox.com",
}
NOT_CONNECTED_MESSAGE = "Square isn't connected yet — ask Saar to connect it. Pick another payment method for now."
POS_CALLBACK_PATH = "/square/callback"

PENDING = "pending"
COMPLETED = "completed"
CANCELED = "canceled"
FAILED = "failed"
REFUNDED = "refunded"
CONFLICT = "conflict"


# --------------------------------------------------------------------------- config


@dataclass(frozen=True)
class SquareConfig:
    access_token: str
    environment: str
    application_id: str
    location_id: str
    fake: bool = False

    @property
    def base_url(self) -> str:
        return SQUARE_BASE_URLS[self.environment]


class SquareNotConfigured(RuntimeError):
    """No Square access token is set (HTTP 503)."""


class SquareServiceError(RuntimeError):
    """Square refused or failed a request, or its answer did not add up."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _clean(raw: str, prefix: str) -> str:
    value = raw.replace("﻿", "").strip()
    if value.upper().startswith(prefix + "="):
        value = value.split("=", 1)[1].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1].strip()
    return "".join(value.split())


def fake_mode_allowed() -> bool:
    """The fake is for local development only: never on Vercel, never against Postgres."""

    return not os.getenv("VERCEL") and get_settings().database_url.startswith("sqlite")


def fake_mode() -> bool:
    if os.getenv("SQUARE_FAKE", "").strip() != "1":
        return False
    if not fake_mode_allowed():
        LOGGER.warning("SQUARE_FAKE=1 ignored: the fake Square is only allowed on a local SQLite database.")
        return False
    return True


def load_config() -> SquareConfig | None:
    """Square settings from the environment, or None when Square is not connected."""

    environment = os.getenv("SQUARE_ENVIRONMENT", "production").strip().lower()
    if environment not in SQUARE_BASE_URLS:
        environment = "production"
    application_id = _clean(os.getenv("SQUARE_APPLICATION_ID", ""), "SQUARE_APPLICATION_ID")
    location_id = _clean(os.getenv("SQUARE_LOCATION_ID", ""), "SQUARE_LOCATION_ID")
    if fake_mode():
        return SquareConfig("fake-token", "sandbox", application_id or "sandbox-sq0idb-FAKE", location_id, fake=True)
    token = _clean(os.getenv("SQUARE_ACCESS_TOKEN", ""), "SQUARE_ACCESS_TOKEN")
    token_path = get_settings().square_token_path
    if not token and token_path.exists():
        token = _clean(token_path.read_text(encoding="utf-8"), "SQUARE_ACCESS_TOKEN")
    if not token:
        return None
    if not token.isascii():
        raise SquareServiceError("The Square access token is malformed. Ask Saar to set it again.", 503)
    return SquareConfig(token, environment, application_id, location_id)


def require_config() -> SquareConfig:
    config = load_config()
    if config is None:
        raise SquareNotConfigured(NOT_CONNECTED_MESSAGE)
    return config


# --------------------------------------------------------------------------- client

# Tests swap Square for an httpx.MockTransport here.
_transport_override: httpx.BaseTransport | None = None


def set_transport(transport: httpx.BaseTransport | None) -> None:
    global _transport_override
    _transport_override = transport
    _LOCATION_CACHE.clear()


class SquareClient:
    """A thin client for Square's REST API (plain httpx, no SDK)."""

    def __init__(self, config: SquareConfig, transport: httpx.BaseTransport | None = None) -> None:
        self.config = config
        if transport is None:
            transport = _transport_override or (FAKE_SQUARE.transport if config.fake else None)
        self._client = httpx.Client(
            base_url=config.base_url,
            timeout=httpx.Timeout(SQUARE_TIMEOUT_SECONDS, connect=5.0),
            transport=transport,
            headers={
                "Authorization": f"Bearer {config.access_token}",
                "Square-Version": SQUARE_API_VERSION,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "SquareClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def request(self, method: str, path: str, *, body: dict | None = None, params: dict | None = None) -> dict:
        try:
            response = self._client.request(method, path, json=body, params=params)
        except httpx.TimeoutException as error:
            raise SquareServiceError("Square took too long to answer. Try again.", 504) from error
        except httpx.HTTPError as error:
            raise SquareServiceError("Could not reach Square. Check the internet connection and try again.", 502) from error
        try:
            payload = response.json() if response.content else {}
        except ValueError:
            payload = {}
        if response.status_code >= 400:
            errors = payload.get("errors") if isinstance(payload, dict) else None
            first = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else {}
            code = str(first.get("code") or "")
            detail = str(first.get("detail") or "")
            LOGGER.warning("Square %s %s failed: %s %s", method, path.split("?")[0], response.status_code, code)
            if response.status_code == 401:
                raise SquareServiceError(
                    "Square rejected the access token. Ask Saar to check the Square connection.", 503
                )
            if response.status_code == 403:
                raise SquareServiceError(
                    f"Square says this app isn't allowed to do that ({code or 'forbidden'}). Ask Saar to check the token's permissions.",
                    503,
                )
            if response.status_code == 429:
                raise SquareServiceError("Square is busy. Wait a moment and try again.", 503)
            message = detail or code or f"error {response.status_code}"
            status = 404 if response.status_code == 404 else 502
            raise SquareServiceError(f"Square: {message}", status)
        return payload if isinstance(payload, dict) else {}


_LOCATION_CACHE: dict[tuple[str, str], dict] = {}


def get_location(client: SquareClient, refresh: bool = False) -> dict:
    """The location sales are taken at: SQUARE_LOCATION_ID, else the first ACTIVE one (cached)."""

    key = (client.config.environment + ("-fake" if client.config.fake else ""), client.config.location_id)
    if not refresh and key in _LOCATION_CACHE:
        return _LOCATION_CACHE[key]
    locations = client.request("GET", "/v2/locations").get("locations") or []
    chosen = None
    if client.config.location_id:
        chosen = next((loc for loc in locations if loc.get("id") == client.config.location_id), None)
        if chosen is None:
            raise SquareServiceError("The Square location set in SQUARE_LOCATION_ID was not found.", 503)
    else:
        chosen = next((loc for loc in locations if loc.get("status") == "ACTIVE"), None)
        if chosen is None:
            raise SquareServiceError("This Square account has no active location.", 503)
    location = {"id": chosen.get("id"), "name": chosen.get("name") or "", "currency": chosen.get("currency") or "USD"}
    _LOCATION_CACHE[key] = location
    return location


def money(cents: int, currency: str = "USD") -> dict:
    return {"amount": int(cents), "currency": currency}


def verify_payment(client: SquareClient, payment_id: str, expected_cents: int, currency: str = "USD") -> dict:
    """Fetch the payment from Square and check it is complete and for exactly the sale total (tip excluded)."""

    payment = client.request("GET", f"/v2/payments/{payment_id}").get("payment") or {}
    status = payment.get("status")
    if status != "COMPLETED":
        raise SquareServiceError(f"Square shows this payment as {status or 'unknown'}, not completed.", 409)
    amount = payment.get("amount_money") or {}
    if int(amount.get("amount") or -1) != expected_cents or (amount.get("currency") or currency) != currency:
        raise SquareServiceError(
            f"Square shows ${from_cents(int(amount.get('amount') or 0)):.2f} paid, "
            f"but this sale is ${from_cents(expected_cents):.2f}.",
            409,
        )
    return payment


# --------------------------------------------------------------------------- schemas


class SquareDeviceRead(SQLModel):
    id: int
    name: str
    paired: bool
    code: str | None = None
    code_status: str
    pair_by: str | None = None
    last_used_at: datetime | None = None


class SquareStatusRead(SQLModel):
    configured: bool
    connected: bool
    fake: bool
    environment: str
    location_name: str = ""
    application_id: str = ""
    error: str = ""
    callback_path: str = POS_CALLBACK_PATH
    api_version: str = SQUARE_API_VERSION
    devices: list[SquareDeviceRead] = Field(default_factory=list)


class SquarePairRequest(SQLModel):
    name: str = Field(default="Square Terminal", min_length=1, max_length=80)


class SquareChargeRequest(SQLModel):
    """Start taking payment for a cart through Square. `client_key` makes a retry safe."""

    client_key: str = Field(min_length=8, max_length=64)
    kind: Literal["terminal", "pos_app", "payment_link"]
    device_id: int | None = None
    redirect_url: str | None = Field(default=None, max_length=500)
    checkout: CheckoutRequest


class SquarePosCallback(SQLModel):
    """What the Square app handed back to the browser; only used to know which transaction to verify."""

    payment_id: int
    transaction_id: str | None = Field(default=None, max_length=255)
    client_transaction_id: str | None = Field(default=None, max_length=255)
    error_code: str | None = Field(default=None, max_length=255)


class SquarePaymentRead(SQLModel):
    id: int
    sale_id: int
    kind: str
    status: str
    amount: float
    amount_cents: int
    currency: str
    square_status: str
    message: str
    link_url: str | None = None
    square_payment_id: str | None = None
    order: OrderRead | None = None
    application_id: str = ""
    created_at: datetime


# --------------------------------------------------------------------------- service


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _lock(session: Session, payment_id: int) -> SquarePayment:
    """Take the square_payment row lock (no-op UPDATE) and reload it, so two polls never finalize twice."""

    session.exec(update(SquarePayment).where(SquarePayment.id == payment_id).values(status=SquarePayment.status))
    payment = session.exec(
        select(SquarePayment).where(SquarePayment.id == payment_id).execution_options(populate_existing=True)
    ).one()
    return payment


def _save(session: Session, payment: SquarePayment, **changes: Any) -> SquarePayment:
    for key, value in changes.items():
        setattr(payment, key, value)
    payment.updated_at = _now()
    session.add(payment)
    session.commit()
    session.refresh(payment)
    return payment


def _frozen_cart(session: Session, sale_id: int, request: CheckoutRequest) -> tuple[dict, int]:
    """Price the cart with the real checkout (then roll it back) and freeze each line's unit price.

    Raises CheckoutConflict / CheckoutError exactly like a normal checkout, so a
    cart that could not be sold is never charged.
    """

    cart = request.model_copy(update={"payment_method": PaymentMethod.SQUARE})
    order = checkout(session, sale_id, cart)
    total_cents = to_cents(order.total)
    snapshot = json.loads(order.lines_json or "[]")
    session.rollback()
    prices = {line["item_id"]: line["unit_price"] for line in snapshot}
    frozen = cart.model_dump(mode="json", exclude={"payment_method"})
    for line in frozen["lines"]:
        line["unit_price"] = prices.get(line["item_id"], line.get("unit_price"))
    return frozen, total_cents


def _sale_label(session: Session, sale_id: int, request: CheckoutRequest) -> str:
    sale = session.get(Sale, sale_id)
    count = sum(line.quantity for line in request.lines)
    title = sale.title if sale else "Estate sale"
    return f"{title} – {count} item{'s' if count != 1 else ''}"[:250]


def start_charge(session: Session, sale_id: int, request: SquareChargeRequest) -> SquarePayment:
    config = require_config()
    existing = session.exec(select(SquarePayment).where(SquarePayment.client_key == request.client_key)).first()
    if existing is not None:
        return existing
    if request.kind == "pos_app" and not config.application_id:
        raise SquareServiceError("The Square app option needs SQUARE_APPLICATION_ID. Ask Saar to set it up.", 503)
    device: SquareDevice | None = None
    if request.kind == "terminal":
        device = session.get(SquareDevice, request.device_id) if request.device_id else None
        if device is None or not device.device_id:
            raise SquareServiceError("Pick a paired Square Terminal first (Square settings → Pair a Terminal).", 422)
    redirect_url = (request.redirect_url or "").strip()
    if request.kind == "payment_link" and redirect_url and not redirect_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise CheckoutError("The return address must be https.")

    cart, amount_cents = _frozen_cart(session, sale_id, request.checkout)
    if amount_cents <= 0:
        raise CheckoutError("There is nothing to charge. Use Cash for a free sale.")
    label = _sale_label(session, sale_id, request.checkout)
    payment = SquarePayment(
        sale_id=sale_id,
        kind=request.kind,
        amount_cents=amount_cents,
        cart_json=json.dumps(cart),
        client_key=request.client_key,
        idempotency_key=uuid.uuid4().hex,
        device_id=device.device_id if device else None,
    )
    session.add(payment)
    session.commit()
    session.refresh(payment)

    try:
        with SquareClient(config) as client:
            if request.kind == "terminal" and device is not None:
                result = client.request(
                    "POST",
                    "/v2/terminals/checkouts",
                    body={
                        "idempotency_key": payment.idempotency_key,
                        "checkout": {
                            "amount_money": money(amount_cents, payment.currency),
                            "reference_id": f"muffines-{payment.id}",
                            "note": label,
                            "device_options": {"device_id": device.device_id},
                        },
                    },
                ).get("checkout") or {}
                if not result.get("id"):
                    raise SquareServiceError("Square did not start the Terminal checkout.")
                device.last_used_at = _now()
                session.add(device)
                return _save(session, payment, square_checkout_id=result["id"], raw_last_status=result.get("status") or "PENDING")
            if request.kind == "payment_link":
                location = get_location(client)
                body: dict[str, Any] = {
                    "idempotency_key": payment.idempotency_key,
                    "quick_pay": {
                        "name": label,
                        "price_money": money(amount_cents, payment.currency),
                        "location_id": location["id"],
                    },
                    "payment_note": f"MuffinES sale #{payment.id}",
                }
                if redirect_url:
                    body["checkout_options"] = {"redirect_url": redirect_url}
                link = client.request("POST", "/v2/online-checkout/payment-links", body=body).get("payment_link") or {}
                if not link.get("id") or not link.get("url"):
                    raise SquareServiceError("Square did not create the payment link.")
                return _save(
                    session,
                    payment,
                    square_checkout_id=link["id"],
                    square_order_id=link.get("order_id"),
                    link_url=link["url"],
                    raw_last_status="OPEN",
                )
            return _save(session, payment, raw_last_status="WAITING_FOR_APP")
    except SquareServiceError as error:
        session.rollback()
        _save(session, session.get(SquarePayment, payment.id), status=FAILED, message=str(error))
        raise


def finalize(session: Session, payment_id: int, square_payment_id: str, square_order_id: str | None = None) -> SquarePayment:
    """Square confirmed the money: record the sale through the normal checkout, once."""

    payment = _lock(session, payment_id)
    if payment.status != PENDING:
        session.commit()
        return payment
    cart = CheckoutRequest.model_validate({**json.loads(payment.cart_json), "payment_method": "square"})
    problem = ""
    try:
        order = checkout(session, payment.sale_id, cart)
        if to_cents(order.total) != payment.amount_cents:
            problem = "the cart's prices changed after the charge started"
    except CheckoutConflict as conflict:
        titles = ", ".join(entry.title for entry in conflict.unavailable)
        problem = f"these items were sold on another device meanwhile: {titles}"
    except CheckoutError as error:
        problem = str(error)
    if problem:
        session.rollback()
        payment = _lock(session, payment_id)
        if payment.status != PENDING:
            session.commit()
            return payment
        LOGGER.warning("Square payment %s was taken but the sale could not be recorded", payment.id)
        return _save(
            session,
            payment,
            status=CONFLICT,
            square_payment_id=square_payment_id,
            square_order_id=square_order_id or payment.square_order_id,
            message=(
                f"Square took ${from_cents(payment.amount_cents):.2f} but nothing was marked sold: {problem}. "
                f"Refund it (Square payment {square_payment_id})."
            ),
        )
    session.flush()
    return _save(
        session,
        payment,
        status=COMPLETED,
        order_id=order.id,
        square_payment_id=square_payment_id,
        square_order_id=square_order_id or payment.square_order_id,
        raw_last_status="COMPLETED",
        message="",
    )


def _fail(session: Session, payment: SquarePayment, message: str, square_payment_id: str | None = None) -> SquarePayment:
    payment = _lock(session, payment.id)
    if payment.status != PENDING:
        session.commit()
        return payment
    return _save(session, payment, status=FAILED, message=message, square_payment_id=square_payment_id or payment.square_payment_id)


def _paid_payment_ids_from_order(order: dict) -> list[str]:
    return [str(t.get("payment_id") or t.get("id")) for t in order.get("tenders") or [] if t.get("payment_id") or t.get("id")]


def _settle_from_order(session: Session, client: SquareClient, payment: SquarePayment, order: dict) -> SquarePayment:
    """An order with tenders is paid: verify the payment amount, then finalize."""

    payment_ids = _paid_payment_ids_from_order(order)
    if len(payment_ids) != 1:
        return _fail(session, payment, "Square shows a split or missing payment for this sale. Check it in Square; nothing was marked sold.")
    try:
        verify_payment(client, payment_ids[0], payment.amount_cents, payment.currency)
    except SquareServiceError as error:
        if error.status_code == 409:
            return _fail(session, payment, f"{error} Nothing was marked sold. Check it in Square.", payment_ids[0])
        raise
    return finalize(session, payment.id, payment_ids[0], order.get("id"))


def refresh(session: Session, payment: SquarePayment) -> SquarePayment:
    """Ask Square how a pending charge is doing; record the sale once it is paid."""

    if payment.status != PENDING or payment.kind == "pos_app":
        return payment
    config = require_config()
    with SquareClient(config) as client:
        if payment.kind == "terminal":
            result = client.request("GET", f"/v2/terminals/checkouts/{payment.square_checkout_id}").get("checkout") or {}
            status = result.get("status") or ""
            if status == "COMPLETED":
                if int((result.get("amount_money") or {}).get("amount") or -1) != payment.amount_cents:
                    return _fail(session, payment, "The Terminal charged a different amount. Check it in Square; nothing was marked sold.")
                payment_ids = result.get("payment_ids") or []
                if not payment_ids:
                    return _fail(session, payment, "Square finished the checkout without a payment. Nothing was marked sold.")
                try:
                    verify_payment(client, payment_ids[0], payment.amount_cents, payment.currency)
                except SquareServiceError as error:
                    if error.status_code == 409:
                        return _fail(session, payment, f"{error} Nothing was marked sold.", payment_ids[0])
                    raise
                return finalize(session, payment.id, payment_ids[0])
            if status == "CANCELED":
                reason = (result.get("cancel_reason") or "").replace("_", " ").lower()
                payment = _lock(session, payment.id)
                if payment.status != PENDING:
                    session.commit()
                    return payment
                return _save(session, payment, status=CANCELED, raw_last_status=status,
                             message=f"Canceled on Square ({reason})." if reason else "Canceled on Square.")
            if status and status != payment.raw_last_status:
                return _save(session, payment, raw_last_status=status)
            return payment
        if payment.kind == "payment_link":
            if not payment.square_order_id:
                link = client.request("GET", f"/v2/online-checkout/payment-links/{payment.square_checkout_id}").get("payment_link") or {}
                if link.get("order_id"):
                    payment = _save(session, payment, square_order_id=link["order_id"])
                else:
                    return payment
            order = client.request("GET", f"/v2/orders/{payment.square_order_id}").get("order") or {}
            if order.get("tenders"):
                return _settle_from_order(session, client, payment, order)
            state = order.get("state") or ""
            if state == "CANCELED":
                return _save(session, payment, status=CANCELED, raw_last_status=state, message="The payment link was canceled in Square.")
            if state and state != payment.raw_last_status:
                return _save(session, payment, raw_last_status=state)
    return payment


def cancel(session: Session, payment: SquarePayment) -> SquarePayment:
    """Stop waiting. If Square was paid in the meantime, the sale is recorded instead."""

    if payment.status != PENDING:
        return payment
    if payment.kind in {"terminal", "payment_link"}:
        config = require_config()
        with SquareClient(config) as client:
            if payment.kind == "terminal":
                try:
                    client.request("POST", f"/v2/terminals/checkouts/{payment.square_checkout_id}/cancel")
                except SquareServiceError as error:
                    # 400 (already completed / canceled) arrives as 502; the status check below decides.
                    if error.status_code not in {404, 502}:
                        raise
                    LOGGER.info("Terminal cancel refused for payment %s; checking its status", payment.id)
            payment = refresh(session, payment)
            if payment.status != PENDING:
                return payment
            if payment.kind == "payment_link" and payment.square_checkout_id:
                try:
                    client.request("DELETE", f"/v2/online-checkout/payment-links/{payment.square_checkout_id}")
                except SquareServiceError:
                    LOGGER.info("Could not delete payment link for payment %s", payment.id)
    payment = _lock(session, payment.id)
    if payment.status != PENDING:
        session.commit()
        return payment
    return _save(session, payment, status=CANCELED, raw_last_status="CANCELED", message="Canceled. Nothing was charged or sold.")


def pos_callback(session: Session, data: SquarePosCallback) -> SquarePayment:
    """The Square app returned. Verify the transaction with Square before recording anything."""

    payment = session.get(SquarePayment, data.payment_id)
    if payment is None or payment.kind != "pos_app":
        raise HTTPException(status_code=404, detail="That Square charge was not found.")
    if payment.status != PENDING:
        return payment
    if data.error_code:
        code = data.error_code.split(".")[-1].lower()
        if "canceled" in code or "cancelled" in code:
            return _save(session, payment, status=CANCELED, raw_last_status=code, message="Canceled in the Square app. Nothing was sold.")
        return _save(session, payment, status=FAILED, raw_last_status=code[:60], message=f"The Square app reported an error ({code}). Nothing was sold.")
    transaction_id = (data.transaction_id or "").strip()
    if not transaction_id:
        return _fail(
            session,
            payment,
            "The Square app didn't send back a transaction (offline mode?). Check the sale in Square; nothing was marked sold.",
        )
    used = session.exec(
        select(SquarePayment).where(SquarePayment.square_order_id == transaction_id, SquarePayment.id != payment.id)
    ).first()
    if used is not None:
        return _fail(session, payment, "That Square transaction was already used for another sale. Nothing was marked sold.")
    config = require_config()
    with SquareClient(config) as client:
        # The Point of Sale API transaction id is the Orders API order id.
        order = client.request("GET", f"/v2/orders/{transaction_id}").get("order") or {}
        if not order.get("tenders"):
            return _fail(session, payment, "Square shows no payment for that transaction. Nothing was marked sold.")
        return _settle_from_order(session, client, payment, order)


def refund(session: Session, payment: SquarePayment, reason: str) -> SquarePayment:
    """Refund the whole Square payment (idempotent: a retry never refunds twice)."""

    if payment.status == REFUNDED:
        return payment
    if not payment.square_payment_id:
        raise SquareServiceError("There is no Square payment to refund.", 409)
    config = require_config()
    with SquareClient(config) as client:
        result = client.request(
            "POST",
            "/v2/refunds",
            body={
                "idempotency_key": f"r{payment.idempotency_key}"[:45],
                "payment_id": payment.square_payment_id,
                "amount_money": money(payment.amount_cents, payment.currency),
                "reason": reason[:192],
            },
        ).get("refund") or {}
    status = result.get("status") or ""
    if status not in {"PENDING", "COMPLETED"}:
        raise SquareServiceError(f"Square did not refund the payment ({status or 'no answer'}). Nothing was voided.", 502)
    payment = _lock(session, payment.id)
    return _save(session, payment, status=REFUNDED, square_refund_id=result.get("id"),
                 message=f"Refunded ${from_cents(payment.amount_cents):.2f} in Square.")


def square_payments_by_order(session: Session, order_ids: list[int]) -> dict[int, SquarePayment]:
    if not order_ids:
        return {}
    rows = session.exec(select(SquarePayment).where(SquarePayment.order_id.in_(order_ids))).all()
    return {row.order_id: row for row in rows if row.order_id is not None}


def to_read(session: Session, payment: SquarePayment, config: SquareConfig | None = None) -> SquarePaymentRead:
    order = None
    if payment.order_id is not None:
        found = session.get(CustomerOrder, payment.order_id)
        if found is not None:
            order = build_order_reads(session, [found])[0]
    return SquarePaymentRead(
        id=payment.id or 0,
        sale_id=payment.sale_id,
        kind=payment.kind,
        status=payment.status,
        amount=from_cents(payment.amount_cents),
        amount_cents=payment.amount_cents,
        currency=payment.currency,
        square_status=payment.raw_last_status,
        message=payment.message,
        link_url=payment.link_url,
        square_payment_id=payment.square_payment_id,
        order=order,
        application_id=(config.application_id if config else ""),
        created_at=payment.created_at if payment.created_at.tzinfo else payment.created_at.replace(tzinfo=timezone.utc),
    )


def device_read(device: SquareDevice) -> SquareDeviceRead:
    return SquareDeviceRead(
        id=device.id or 0,
        name=device.name,
        paired=bool(device.device_id),
        code=None if device.device_id else device.code,
        code_status=device.code_status,
        pair_by=device.pair_by,
        last_used_at=device.last_used_at,
    )


def refresh_devices(session: Session, client: SquareClient) -> list[SquareDevice]:
    devices = list(session.exec(select(SquareDevice).order_by(SquareDevice.id)).all())
    for device in devices:
        if device.device_id or not device.device_code_id or device.code_status != "UNPAIRED":
            continue
        code = client.request("GET", f"/v2/devices/codes/{device.device_code_id}").get("device_code") or {}
        status = code.get("status") or device.code_status
        if code.get("device_id") and status == "PAIRED":
            device.device_id = code["device_id"]
        device.code_status = status
        session.add(device)
    session.commit()
    return devices


# --------------------------------------------------------------------------- routes

router = APIRouter()
PREFIX = get_settings().api_prefix


def _http(error: Exception) -> HTTPException:
    if isinstance(error, SquareNotConfigured):
        return HTTPException(status_code=503, detail=str(error))
    if isinstance(error, SquareServiceError):
        return HTTPException(status_code=error.status_code, detail=str(error))
    raise error


def _payment_or_404(session: Session, payment_id: int) -> SquarePayment:
    payment = session.get(SquarePayment, payment_id)
    if payment is None:
        raise HTTPException(status_code=404, detail="That Square charge was not found.")
    return payment


@router.get(f"{PREFIX}/square/status", response_model=SquareStatusRead)
def read_square_status(session: Session = Depends(get_db)) -> SquareStatusRead:
    """Is Square connected? Shows the location name, never the token."""

    environment = os.getenv("SQUARE_ENVIRONMENT", "production").strip().lower()
    try:
        config = load_config()
    except SquareServiceError as error:
        return SquareStatusRead(configured=False, connected=False, fake=False, environment=environment, error=str(error))
    if config is None:
        return SquareStatusRead(configured=False, connected=False, fake=False, environment=environment, error=NOT_CONNECTED_MESSAGE)
    status = SquareStatusRead(
        configured=True, connected=False, fake=config.fake, environment=config.environment, application_id=config.application_id
    )
    try:
        with SquareClient(config) as client:
            status.location_name = get_location(client, refresh=True)["name"]
            status.connected = True
            status.devices = [device_read(device) for device in refresh_devices(session, client)]
    except SquareServiceError as error:
        status.error = str(error)
        status.devices = [device_read(d) for d in session.exec(select(SquareDevice).order_by(SquareDevice.id)).all()]
    return status


@router.get(f"{PREFIX}/square/devices", response_model=list[SquareDeviceRead])
def read_square_devices(session: Session = Depends(get_db)) -> list[SquareDeviceRead]:
    try:
        with SquareClient(require_config()) as client:
            return [device_read(device) for device in refresh_devices(session, client)]
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None


@router.post(f"{PREFIX}/square/devices", response_model=SquareDeviceRead)
def pair_square_device(payload: SquarePairRequest, session: Session = Depends(get_db)) -> SquareDeviceRead:
    """Get a pairing code to type into a Square Terminal (Terminal API device code)."""

    try:
        with SquareClient(require_config()) as client:
            location = get_location(client)
            code = client.request(
                "POST",
                "/v2/devices/codes",
                body={
                    "idempotency_key": uuid.uuid4().hex,
                    "device_code": {
                        "name": payload.name.strip()[:80],
                        "product_type": "TERMINAL_API",
                        "location_id": location["id"],
                    },
                },
            ).get("device_code") or {}
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None
    if not code.get("code"):
        raise HTTPException(status_code=502, detail="Square did not return a pairing code.")
    device = SquareDevice(
        name=payload.name.strip(),
        device_code_id=code.get("id"),
        code=code.get("code"),
        code_status=code.get("status") or "UNPAIRED",
        pair_by=code.get("pair_by"),
        location_id=location["id"],
    )
    session.add(device)
    session.commit()
    session.refresh(device)
    return device_read(device)


@router.delete(f"{PREFIX}/square/devices/{{device_pk}}", response_model=dict)
def remove_square_device(device_pk: int, session: Session = Depends(get_db)) -> dict:
    """Forget a paired Terminal here (unpair it on the Terminal itself to reuse it elsewhere)."""

    device = session.get(SquareDevice, device_pk)
    if device is not None:
        session.delete(device)
        session.commit()
    return {"ok": True}


@router.post(f"{PREFIX}/sales/{{sale_id}}/square/charges", response_model=SquarePaymentRead)
def start_square_charge(sale_id: int, payload: SquareChargeRequest, session: Session = Depends(get_db)) -> SquarePaymentRead:
    """Start charging a cart through Square. Nothing is sold until Square confirms the money."""

    if session.get(Sale, sale_id) is None:
        raise HTTPException(status_code=404, detail="Estate sale not found.")
    try:
        payment = start_charge(session, sale_id, payload)
    except CheckoutConflict as conflict:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Some items in this sale are no longer available.",
                "unavailable": [entry.model_dump() for entry in conflict.unavailable],
            },
        ) from None
    except CheckoutError as error:
        session.rollback()
        raise HTTPException(status_code=422, detail=str(error)) from None
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None
    return to_read(session, payment, load_config())


@router.get(f"{PREFIX}/square/payments/{{payment_id}}", response_model=SquarePaymentRead)
def read_square_payment(payment_id: int, session: Session = Depends(get_db)) -> SquarePaymentRead:
    """Poll a charge: asks Square, and records the sale the moment it is paid."""

    payment = _payment_or_404(session, payment_id)
    try:
        payment = refresh(session, payment)
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None
    return to_read(session, payment, load_config())


@router.post(f"{PREFIX}/square/payments/{{payment_id}}/cancel", response_model=SquarePaymentRead)
def cancel_square_payment(payment_id: int, session: Session = Depends(get_db)) -> SquarePaymentRead:
    payment = _payment_or_404(session, payment_id)
    try:
        payment = cancel(session, payment)
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None
    return to_read(session, payment, load_config())


@router.post(f"{PREFIX}/square/payments/{{payment_id}}/refund", response_model=SquarePaymentRead)
def refund_square_payment(payment_id: int, session: Session = Depends(get_db)) -> SquarePaymentRead:
    """Refund money Square took for a sale that could not be recorded (conflict / mismatch)."""

    payment = _payment_or_404(session, payment_id)
    if payment.status not in {CONFLICT, FAILED, REFUNDED}:
        raise HTTPException(status_code=409, detail="Use Void on the sale to refund a completed Square sale.")
    try:
        payment = refund(session, payment, "Items no longer available")
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None
    return to_read(session, payment, load_config())


@router.post(f"{PREFIX}/square/pos-callback", response_model=SquarePaymentRead)
def square_pos_callback(payload: SquarePosCallback, session: Session = Depends(get_db)) -> SquarePaymentRead:
    try:
        payment = pos_callback(session, payload)
    except (SquareNotConfigured, SquareServiceError) as error:
        raise _http(error) from None
    return to_read(session, payment, load_config())


@router.post(f"{PREFIX}/sales/{{sale_id}}/orders/{{order_id}}/refund-and-void", response_model=OrderRead)
def refund_and_void_order(sale_id: int, order_id: int, session: Session = Depends(get_db)) -> OrderRead:
    """Refund a Square-paid sale in Square, then void it. If the refund fails nothing is voided."""

    order = session.get(CustomerOrder, order_id)
    if order is None or order.sale_id != sale_id:
        raise HTTPException(status_code=404, detail="Sale not found.")
    payment = square_payments_by_order(session, [order_id]).get(order_id)
    if payment is None:
        raise HTTPException(status_code=409, detail="This sale was not paid through Square.")
    if order.voided_at is None:
        try:
            refund(session, payment, "Sale voided")
        except (SquareNotConfigured, SquareServiceError) as error:
            raise _http(error) from None
        order = session.get(CustomerOrder, order_id)
        void_order(session, order)
        session.commit()
        session.refresh(order)
    return build_order_reads(session, [order])[0]


@router.post(f"{PREFIX}/square/fake/payments/{{payment_id}}/pay", response_model=dict)
def fake_pay(payment_id: int, session: Session = Depends(get_db)) -> dict:
    """SQUARE_FAKE only: the customer pays (link), the Terminal finishes, or the Square app returns."""

    if not (load_config() or SquareConfig("", "sandbox", "", "")).fake:
        raise HTTPException(status_code=404, detail="Not found")
    payment = _payment_or_404(session, payment_id)
    if payment.kind == "payment_link" and payment.square_checkout_id:
        FAKE_SQUARE.pay_link(payment.square_checkout_id)
        return {"ok": True}
    if payment.kind == "terminal" and payment.square_checkout_id:
        FAKE_SQUARE.finish_terminal(payment.square_checkout_id)
        return {"ok": True}
    return {"ok": True, "transaction_id": FAKE_SQUARE.complete_pos(payment.amount_cents)}


# --------------------------------------------------------------------------- fake Square


def _fake_id(prefix: str) -> str:
    return prefix + "".join(random.choices(string.ascii_uppercase + string.digits, k=18))


@dataclass
class FakeSquare:
    """An in-memory stand-in for the Square endpoints used above (local development and tests).

    Terminal checkouts complete `terminal_seconds` after creation, device codes
    pair after `pair_seconds`, payment links are paid with `pay_link()`.
    """

    terminal_seconds: float = 6.0
    pair_seconds: float = 4.0
    paid_amount_override: int | None = None
    fail_refunds: bool = False
    calls: list[tuple[str, str]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _state: dict[str, dict] = field(default_factory=dict)

    def reset(self) -> None:
        with self._lock:
            self._state.clear()
            self.calls.clear()
            self.paid_amount_override = None
            self.fail_refunds = False

    def _bucket(self, name: str) -> dict:
        return self._state.setdefault(name, {})

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _payment(self, amount: int, order_id: str | None = None) -> dict:
        payment_id = _fake_id("PAY")
        payment = {
            "id": payment_id,
            "status": "COMPLETED",
            "amount_money": money(self.paid_amount_override if self.paid_amount_override is not None else amount),
            "order_id": order_id,
        }
        self._bucket("payments")[payment_id] = payment
        return payment

    def pay_link(self, link_id: str) -> None:
        with self._lock:
            link = self._bucket("links")[link_id]
            order = self._bucket("orders")[link["order_id"]]
            payment = self._payment(order["total_money"]["amount"], order["id"])
            order["tenders"] = [{"id": payment["id"], "payment_id": payment["id"], "amount_money": payment["amount_money"]}]
            order["state"] = "COMPLETED"

    def finish_terminal(self, checkout_id: str) -> None:
        with self._lock:
            self._bucket("checkouts")[checkout_id]["created"] = 0.0

    def complete_pos(self, amount: int) -> str:
        with self._lock:
            order_id = _fake_id("POS")
            payment = self._payment(amount, order_id)
            self._bucket("orders")[order_id] = {
                "id": order_id,
                "state": "COMPLETED",
                "total_money": money(amount),
                "tenders": [{"id": payment["id"], "payment_id": payment["id"], "amount_money": payment["amount_money"]}],
            }
            return order_id

    def handle(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            path = request.url.path
            self.calls.append((request.method, path))
            body = json.loads(request.content) if request.content else {}
            key = body.get("idempotency_key")
            if key and key in self._bucket("idem"):
                return httpx.Response(200, json=self._bucket("idem")[key])
            result = self._route(request.method, path, body)
            if isinstance(result, httpx.Response):
                return result
            if key:
                self._bucket("idem")[key] = result
            return httpx.Response(200, json=result)

    def _route(self, method: str, path: str, body: dict) -> dict | httpx.Response:
        parts = path.strip("/").split("/")
        not_found = httpx.Response(404, json={"errors": [{"code": "NOT_FOUND", "detail": "Not found."}]})
        if path == "/v2/locations":
            return {"locations": [{"id": "FAKE-LOC", "name": "Muffin Manor (fake Square)", "status": "ACTIVE", "currency": "USD"}]}
        if path == "/v2/devices/codes" and method == "POST":
            code_id = _fake_id("DC")
            code = {
                "id": code_id,
                "code": "".join(random.choices(string.ascii_uppercase, k=6)),
                "status": "UNPAIRED",
                "product_type": "TERMINAL_API",
                "location_id": body["device_code"]["location_id"],
                "pair_by": datetime.now(timezone.utc).isoformat(),
                "created": time.monotonic(),
            }
            self._bucket("codes")[code_id] = code
            return {"device_code": {k: v for k, v in code.items() if k != "created"}}
        if parts[:3] == ["v2", "devices", "codes"] and len(parts) == 4:
            code = self._bucket("codes").get(parts[3])
            if code is None:
                return not_found
            if code["status"] == "UNPAIRED" and time.monotonic() - code["created"] >= self.pair_seconds:
                code["status"] = "PAIRED"
                code["device_id"] = _fake_id("device:")
            return {"device_code": {k: v for k, v in code.items() if k != "created"}}
        if path == "/v2/terminals/checkouts" and method == "POST":
            checkout_id = _fake_id("TC")
            entry = {**body["checkout"], "id": checkout_id, "status": "PENDING", "created": time.monotonic()}
            self._bucket("checkouts")[checkout_id] = entry
            return {"checkout": {k: v for k, v in entry.items() if k != "created"}}
        if parts[:3] == ["v2", "terminals", "checkouts"] and len(parts) >= 4:
            entry = self._bucket("checkouts").get(parts[3])
            if entry is None:
                return not_found
            if entry["status"] in {"PENDING", "IN_PROGRESS"}:
                elapsed = time.monotonic() - entry["created"]
                if elapsed >= self.terminal_seconds:
                    entry["status"] = "COMPLETED"
                    entry["payment_ids"] = [self._payment(entry["amount_money"]["amount"])["id"]]
                elif elapsed >= min(1.5, self.terminal_seconds / 2):
                    entry["status"] = "IN_PROGRESS"
            if len(parts) == 5 and parts[4] == "cancel":
                if entry["status"] == "COMPLETED":
                    return httpx.Response(400, json={"errors": [{"code": "BAD_REQUEST", "detail": "Checkout already completed."}]})
                entry["status"] = "CANCELED"
                entry["cancel_reason"] = "SELLER_CANCELED"
            return {"checkout": {k: v for k, v in entry.items() if k != "created"}}
        if path == "/v2/online-checkout/payment-links" and method == "POST":
            link_id = _fake_id("PL")
            order_id = _fake_id("ORD")
            price = body["quick_pay"]["price_money"]
            self._bucket("orders")[order_id] = {"id": order_id, "state": "OPEN", "total_money": price, "tenders": []}
            link = {"id": link_id, "url": f"https://sandbox.square.link/u/{link_id[-8:]}", "order_id": order_id}
            self._bucket("links")[link_id] = link
            return {"payment_link": link}
        if parts[:3] == ["v2", "online-checkout", "payment-links"] and len(parts) == 4:
            link = self._bucket("links").get(parts[3])
            if link is None:
                return not_found
            if method == "DELETE":
                self._bucket("links").pop(parts[3])
                return {"id": parts[3]}
            return {"payment_link": link}
        if parts[:2] == ["v2", "orders"] and len(parts) == 3:
            order = self._bucket("orders").get(parts[2])
            return {"order": order} if order else not_found
        if parts[:2] == ["v2", "payments"] and len(parts) == 3:
            payment = self._bucket("payments").get(parts[2])
            return {"payment": payment} if payment else not_found
        if path == "/v2/refunds" and method == "POST":
            if self.fail_refunds:
                return httpx.Response(400, json={"errors": [{"code": "INSUFFICIENT_FUNDS", "detail": "Not enough funds to refund."}]})
            if body.get("payment_id") not in self._bucket("payments"):
                return not_found
            return {"refund": {"id": _fake_id("REF"), "status": "PENDING", "payment_id": body["payment_id"], "amount_money": body["amount_money"]}}
        return not_found


FAKE_SQUARE = FakeSquare()
