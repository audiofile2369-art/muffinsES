"""Taking payment through Square (Terminal, POS app, payment link) against a mocked Square API."""

from __future__ import annotations

import dataclasses
import json
import os
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

TEST_DATABASE_PATH = Path(__file__).resolve().parents[2] / "data" / "test-square.db"
TEST_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
# Never let this module fall through to a configured remote database when run on its own.
os.environ.setdefault("MUFFINES_DATABASE_PATH", str(TEST_DATABASE_PATH))

from backend.core import square  # noqa: E402
from backend.main import app  # noqa: E402


@pytest.fixture()
def fake(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A connected Square account backed by the in-memory fake, with every request recorded."""

    settings = dataclasses.replace(square.get_settings(), square_token_path=tmp_path / "missing.txt")
    monkeypatch.setattr(square, "get_settings", lambda: settings)
    for name in ("SQUARE_FAKE", "SQUARE_LOCATION_ID", "SQUARE_ENVIRONMENT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SQUARE_ACCESS_TOKEN", "test-token")
    monkeypatch.setenv("SQUARE_APPLICATION_ID", "sq0idp-test")
    instance = square.FakeSquare(terminal_seconds=3600, pair_seconds=0)
    requests: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return instance.handle(request)

    square.set_transport(httpx.MockTransport(record))
    instance.requests = requests  # type: ignore[attr-defined]
    yield instance
    square.set_transport(None)


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


def _sale(client: TestClient) -> int:
    return client.post(
        "/api/sales", json={"title": "Square test", "start_date": "2026-10-03", "end_date": "2026-10-04"}
    ).json()["id"]


def _item(client: TestClient, sale_id: int, title: str, price: float) -> int:
    return client.post("/api/items", json={"sale_id": sale_id, "title": title, "price": price}).json()["id"]


def _status(client: TestClient, item_id: int) -> str:
    return next(item["status"] for item in client.get("/api/items").json() if item["id"] == item_id)


def _charge(client: TestClient, sale_id: int, kind: str, lines: list[dict], **extra) -> httpx.Response:
    body = {
        "client_key": extra.pop("client_key", uuid.uuid4().hex),
        "kind": kind,
        "checkout": {"lines": lines, "payment_method": "square", **extra.pop("checkout", {})},
        **extra,
    }
    return client.post(f"/api/sales/{sale_id}/square/charges", json=body)


def _paired_device(client: TestClient) -> int:
    device = client.post("/api/square/devices", json={"name": "Front table"}).json()
    assert device["code"] and not device["paired"]
    devices = client.get("/api/square/devices").json()
    assert devices[-1]["paired"] is True and devices[-1]["code"] is None
    return devices[-1]["id"]


def test_not_configured_gives_a_clear_503_and_charges_nothing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, client) -> None:
    settings = dataclasses.replace(square.get_settings(), square_token_path=tmp_path / "missing.txt")
    monkeypatch.setattr(square, "get_settings", lambda: settings)
    monkeypatch.delenv("SQUARE_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("SQUARE_FAKE", raising=False)
    sale_id = _sale(client)
    item_id = _item(client, sale_id, "Lamp", 20)

    status = client.get("/api/square/status").json()
    assert status["configured"] is False and "ask Saar" in status["error"]
    response = _charge(client, sale_id, "payment_link", [{"item_id": item_id}])
    assert response.status_code == 503 and "isn't connected" in response.json()["detail"]
    assert _status(client, item_id) == "available"


def test_token_file_fallback_is_read_and_never_returned(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fake, client) -> None:
    token_file = tmp_path / "square token.txt"
    token_file.write_text('SQUARE_ACCESS_TOKEN="file-token"\n', encoding="utf-8")
    settings = dataclasses.replace(square.get_settings(), square_token_path=token_file)
    monkeypatch.setattr(square, "get_settings", lambda: settings)
    monkeypatch.delenv("SQUARE_ACCESS_TOKEN")
    response = client.get("/api/square/status")
    assert response.json()["connected"] is True
    assert "file-token" not in response.text
    assert fake.requests[-1].headers["Authorization"] == "Bearer file-token"


def test_location_lookup_uses_first_active_or_the_configured_id(monkeypatch: pytest.MonkeyPatch) -> None:
    locations = [
        {"id": "L0", "name": "Old shop", "status": "INACTIVE"},
        {"id": "L1", "name": "Estate sales", "status": "ACTIVE"},
        {"id": "L2", "name": "Warehouse", "status": "ACTIVE"},
    ]
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"locations": locations})

    config = square.SquareConfig("t", "sandbox", "", "")
    square.set_transport(None)
    with square.SquareClient(config, httpx.MockTransport(handler)) as sq:
        assert square.get_location(sq)["name"] == "Estate sales"
        assert square.get_location(sq)["id"] == "L1"  # cached: one request
    assert len(seen) == 1
    assert seen[0].url.host == "connect.squareupsandbox.com"
    assert seen[0].headers["Square-Version"] == square.SQUARE_API_VERSION
    with square.SquareClient(square.SquareConfig("t", "production", "", "L2"), httpx.MockTransport(handler)) as sq:
        assert square.get_location(sq)["name"] == "Warehouse"
    assert seen[-1].url.host == "connect.squareup.com"
    square.set_transport(None)


def test_square_errors_map_to_clear_messages() -> None:
    def unauthorized(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errors": [{"code": "UNAUTHORIZED", "detail": "bad"}]})

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    config = square.SquareConfig("t", "sandbox", "", "")
    with pytest.raises(square.SquareServiceError) as error:
        square.SquareClient(config, httpx.MockTransport(unauthorized)).request("GET", "/v2/locations")
    assert error.value.status_code == 503 and "access token" in str(error.value)
    with pytest.raises(square.SquareServiceError) as error:
        square.SquareClient(config, httpx.MockTransport(slow)).request("GET", "/v2/locations")
    assert error.value.status_code == 504


def test_terminal_checkout_records_the_sale_only_when_paid(fake, client) -> None:
    sale_id = _sale(client)
    lamp = _item(client, sale_id, "Lamp", 20)
    chair = _item(client, sale_id, "Chair", 35.5)
    device_id = _paired_device(client)
    key = uuid.uuid4().hex

    started = _charge(
        client, sale_id, "terminal",
        [{"item_id": lamp}, {"item_id": chair, "unit_price": 30}],
        device_id=device_id, client_key=key, checkout={"discount_amount": 5, "note": "Mrs. B"},
    )
    assert started.status_code == 200, started.text
    payment = started.json()
    assert payment["status"] == "pending" and payment["amount_cents"] == 4500
    assert _charge(client, sale_id, "terminal", [{"item_id": lamp}], device_id=device_id, client_key=key).json()["id"] == payment["id"]
    created = [r for r in fake.requests if r.url.path == "/v2/terminals/checkouts"]
    assert len(created) == 1
    sent = json.loads(created[0].content)
    assert sent["checkout"]["amount_money"] == {"amount": 4500, "currency": "USD"}
    assert sent["idempotency_key"] and sent["checkout"]["device_options"]["device_id"].startswith("device:")

    polled = client.get(f"/api/square/payments/{payment['id']}").json()
    assert polled["status"] == "pending" and polled["order"] is None
    assert _status(client, lamp) == "available"

    fake.finish_terminal(next(iter(fake._state["checkouts"])))
    done = client.get(f"/api/square/payments/{payment['id']}").json()
    assert done["status"] == "completed", done
    order = done["order"]
    assert order["payment_method"] == "square" and order["total"] == 45 and order["note"] == "Mrs. B"
    assert order["square_payment_id"] == done["square_payment_id"] and order["square_status"] == "completed"
    assert _status(client, lamp) == "sold" and _status(client, chair) == "sold"

    # Polling again never records a second sale.
    assert client.get(f"/api/square/payments/{payment['id']}").json()["order"]["id"] == order["id"]
    orders = client.get(f"/api/sales/{sale_id}/orders").json()
    assert [o["id"] for o in orders] == [order["id"]]
    # Every write sent to Square carried an idempotency key.
    for request in fake.requests:
        if request.method == "POST" and request.content:
            assert json.loads(request.content).get("idempotency_key")


def test_items_sold_elsewhere_during_payment_are_recorded_as_a_conflict(fake, client) -> None:
    sale_id = _sale(client)
    vase = _item(client, sale_id, "Vase", 12)
    device_id = _paired_device(client)
    payment = _charge(client, sale_id, "terminal", [{"item_id": vase}], device_id=device_id).json()
    # Another tablet sells the vase for cash while the customer is tapping their card.
    assert client.post(f"/api/sales/{sale_id}/checkout", json={"lines": [{"item_id": vase}], "payment_method": "cash"}).status_code == 200
    for checkout_id in list(fake._state["checkouts"]):
        fake.finish_terminal(checkout_id)

    result = client.get(f"/api/square/payments/{payment['id']}").json()
    assert result["status"] == "conflict" and result["order"] is None
    assert result["square_payment_id"] in result["message"] and "Vase" in result["message"]
    assert [o["payment_method"] for o in client.get(f"/api/sales/{sale_id}/orders").json()] == ["cash"]

    refunded = client.post(f"/api/square/payments/{payment['id']}/refund").json()
    assert refunded["status"] == "refunded"


def test_cancel_stops_the_terminal_and_sells_nothing(fake, client) -> None:
    sale_id = _sale(client)
    rug = _item(client, sale_id, "Rug", 80)
    device_id = _paired_device(client)
    payment = _charge(client, sale_id, "terminal", [{"item_id": rug}], device_id=device_id).json()
    canceled = client.post(f"/api/square/payments/{payment['id']}/cancel").json()
    assert canceled["status"] == "canceled"
    assert any(r.url.path.endswith("/cancel") for r in fake.requests)
    assert _status(client, rug) == "available"
    assert client.get(f"/api/square/payments/{payment['id']}").json()["status"] == "canceled"


def test_cancel_after_the_customer_already_paid_records_the_sale(fake, client) -> None:
    sale_id = _sale(client)
    rug = _item(client, sale_id, "Rug", 80)
    device_id = _paired_device(client)
    payment = _charge(client, sale_id, "terminal", [{"item_id": rug}], device_id=device_id).json()
    for checkout_id in list(fake._state["checkouts"]):
        fake.finish_terminal(checkout_id)
    assert client.post(f"/api/square/payments/{payment['id']}/cancel").json()["status"] == "completed"
    assert _status(client, rug) == "sold"


def test_payment_link_flow(fake, client) -> None:
    sale_id = _sale(client)
    clock = _item(client, sale_id, "Clock", 40)
    started = _charge(
        client, sale_id, "payment_link", [{"item_id": clock}],
        redirect_url="https://muffins-es.vercel.app/#/checkout/1", checkout={"discount_percent": 25},
    ).json()
    assert started["link_url"].startswith("https://") and started["amount_cents"] == 3000
    sent = json.loads(next(r for r in fake.requests if r.url.path == "/v2/online-checkout/payment-links").content)
    assert sent["quick_pay"]["price_money"] == {"amount": 3000, "currency": "USD"}
    assert sent["quick_pay"]["location_id"] == "FAKE-LOC"
    assert sent["checkout_options"]["redirect_url"].startswith("https://")

    assert client.get(f"/api/square/payments/{started['id']}").json()["status"] == "pending"
    fake.pay_link(next(iter(fake._state["links"])))
    done = client.get(f"/api/square/payments/{started['id']}").json()
    assert done["status"] == "completed" and done["order"]["total"] == 30
    assert _status(client, clock) == "sold"


def test_pos_callback_is_verified_with_square(fake, client) -> None:
    sale_id = _sale(client)
    desk = _item(client, sale_id, "Desk", 150)
    payment = _charge(client, sale_id, "pos_app", [{"item_id": desk}]).json()
    assert payment["application_id"] == "sq0idp-test"

    # The app returns a transaction for a smaller amount: rejected, nothing sold.
    fake.paid_amount_override = 100
    cheap = fake.complete_pos(100)
    rejected = client.post("/api/square/pos-callback", json={"payment_id": payment["id"], "transaction_id": cheap}).json()
    assert rejected["status"] == "failed" and "150.00" in rejected["message"]
    assert _status(client, desk) == "available"

    fake.paid_amount_override = None
    second = _charge(client, sale_id, "pos_app", [{"item_id": desk}]).json()
    transaction = fake.complete_pos(15000)
    accepted = client.post("/api/square/pos-callback", json={"payment_id": second["id"], "transaction_id": transaction}).json()
    assert accepted["status"] == "completed" and accepted["order"]["total"] == 150
    assert _status(client, desk) == "sold"
    # Repeating the callback is harmless; reusing the transaction for another charge is refused.
    assert client.post("/api/square/pos-callback", json={"payment_id": second["id"], "transaction_id": transaction}).json()["order"]["id"] == accepted["order"]["id"]
    lamp = _item(client, sale_id, "Lamp", 150)
    third = _charge(client, sale_id, "pos_app", [{"item_id": lamp}]).json()
    reused = client.post("/api/square/pos-callback", json={"payment_id": third["id"], "transaction_id": transaction}).json()
    assert reused["status"] == "failed" and "already used" in reused["message"]

    fourth = _charge(client, sale_id, "pos_app", [{"item_id": lamp}]).json()
    canceled = client.post(
        "/api/square/pos-callback",
        json={"payment_id": fourth["id"], "error_code": "com.squareup.pos.ERROR_TRANSACTION_CANCELED"},
    ).json()
    assert canceled["status"] == "canceled"


def test_refund_then_void_and_a_failed_refund_blocks_the_void(fake, client) -> None:
    sale_id = _sale(client)
    one = _item(client, sale_id, "Mirror", 25)
    two = _item(client, sale_id, "Frame", 10)
    paid = []
    for item_id in (one, two):
        payment = _charge(client, sale_id, "payment_link", [{"item_id": item_id}]).json()
        fake.pay_link(list(fake._state["links"])[-1])
        paid.append(client.get(f"/api/square/payments/{payment['id']}").json()["order"])

    voided = client.post(f"/api/sales/{sale_id}/orders/{paid[0]['id']}/refund-and-void")
    assert voided.status_code == 200 and voided.json()["voided"] and voided.json()["square_status"] == "refunded"
    assert _status(client, one) == "available"
    refunds = [json.loads(r.content) for r in fake.requests if r.url.path == "/v2/refunds"]
    assert refunds[-1]["amount_money"] == {"amount": 2500, "currency": "USD"} and refunds[-1]["idempotency_key"]

    fake.fail_refunds = True
    blocked = client.post(f"/api/sales/{sale_id}/orders/{paid[1]['id']}/refund-and-void")
    assert blocked.status_code == 502 and "funds" in blocked.json()["detail"]
    assert _status(client, two) == "sold"
    order = next(o for o in client.get(f"/api/sales/{sale_id}/orders").json() if o["id"] == paid[1]["id"])
    assert order["voided"] is False and order["square_status"] == "completed"


def test_fake_mode_is_refused_on_vercel(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SQUARE_FAKE", "1")
    assert square.fake_mode() is True  # local SQLite test database
    monkeypatch.setenv("VERCEL", "1")
    assert square.fake_mode() is False
