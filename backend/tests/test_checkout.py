"""Customer sales (checkout of a cart), voiding, and their effect on totals."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TEST_DATABASE_PATH = Path(__file__).resolve().parents[2] / "data" / "test-checkout.db"
TEST_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
# Never let this module fall through to a configured remote database when run on its own.
os.environ.setdefault("MUFFINES_DATABASE_PATH", str(TEST_DATABASE_PATH))

from backend.core.checkout import CheckoutError, price_order  # noqa: E402
from backend.main import app  # noqa: E402


def _sale(client: TestClient, title: str) -> int:
    return client.post(
        "/api/sales", json={"title": title, "start_date": "2026-10-03", "end_date": "2026-10-04"}
    ).json()["id"]


def _item(client: TestClient, sale_id: int, title: str, price: float, quantity: int = 1) -> dict:
    return client.post(
        "/api/items", json={"sale_id": sale_id, "title": title, "price": price, "quantity": quantity}
    ).json()


def _items_by_id(client: TestClient, sale_id: int) -> dict[int, dict]:
    return {item["id"]: item for item in client.get(f"/api/sales/{sale_id}/workspace").json()["items"]}


def _event_amounts(client: TestClient, sale_id: int, order_id: int) -> list[float]:
    return [
        event["amount"]
        for item in _items_by_id(client, sale_id).values()
        for event in item["sale_events"]
        if event["order_id"] == order_id
    ]


def test_price_order_splits_the_total_exactly_with_the_remainder_on_the_last_line() -> None:
    three = price_order([(1, 5, 0), (1, 5, 0), (1, 5, 0)], set_total=10)
    assert [line.amount_cents for line in three.lines] == [333, 333, 334]
    assert three.total_cents == 1000 and three.discount_total_cents == 500

    odd = price_order([(3, 0.99, 0), (1, 12.5, 2.5), (2, 7.33, 0)], discount_percent=25)
    assert odd.items_total_cents == 297 + 1000 + 1466
    assert odd.order_discount_cents == round(2763 * 0.25 + 1e-9)  # 690.75 -> 691 cents
    assert sum(line.amount_cents for line in odd.lines) == odd.total_cents == 2763 - 691

    # Many tiny lines where per-line rounding up would overshoot: still exact and never negative.
    tiny = price_order([(1, 0.01, 0)] * 7 + [(1, 0.0, 0)], set_total=0.05)
    assert sum(line.amount_cents for line in tiny.lines) == 5
    assert all(line.amount_cents >= 0 for line in tiny.lines)

    # A discount bigger than the items is capped at zero total; a line discount at the line.
    capped = price_order([(1, 10, 25)], discount_amount=50)
    assert capped.total_cents == 0 and capped.lines[0].net_cents == 0

    with pytest.raises(CheckoutError):
        price_order([(1, 10, 0)], set_total=11)
    with pytest.raises(CheckoutError):
        price_order([(1, 10, 0)], discount_amount=1, discount_percent=5)


def test_checkout_sells_a_cart_with_price_changes_and_discounts_all_at_once() -> None:
    with TestClient(app) as client:
        sale_id = _sale(client, "Checkout Sale")
        lamp = _item(client, sale_id, "Brass lamp", 40)
        chairs = _item(client, sale_id, "Dining chair", 15, quantity=6)
        vase = _item(client, sale_id, "Blue vase", 12.5)
        rug = _item(client, sale_id, "Wool rug", 80)

        response = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={
                "lines": [
                    {"item_id": lamp["id"], "quantity": 1, "unit_price": 30},  # price changed
                    {"item_id": chairs["id"], "quantity": 4},  # listed price 15
                    {"item_id": vase["id"], "quantity": 1, "line_discount": 2.5},
                    {"item_id": rug["id"], "quantity": 1},
                ],
                "discount_percent": 25,
                "payment_method": "cash",
                "note": "  Blue hat lady  ",
                # Client totals are ignored even if sent.
                "total": 1,
            },
        )
        assert response.status_code == 200, response.text
        order = response.json()
        # subtotal 30 + 60 + 12.5 + 80 = 182.5; items after line discount 180; 25% off = 45 -> 135
        assert order["subtotal"] == 182.5
        assert order["total"] == 135
        assert order["discount_total"] == 47.5
        assert order["received_total"] == 135
        assert order["item_count"] == 7
        assert order["payment_method"] == "cash"
        assert order["note"] == "Blue hat lady"
        assert [line["title"] for line in order["lines"]] == ["Brass lamp", "Dining chair", "Blue vase", "Wool rug"]
        assert order["lines"][0]["unit_price"] == 30 and order["lines"][0]["list_price"] == 40
        assert order["lines"][2]["line_discount"] == 2.5
        assert round(sum(line["amount"] for line in order["lines"]), 2) == 135
        assert sorted(_event_amounts(client, sale_id, order["id"])) == sorted(
            line["amount"] for line in order["lines"]
        )

        items = _items_by_id(client, sale_id)
        assert items[lamp["id"]]["status"] == "sold"
        assert items[chairs["id"]]["status"] == "available"  # 2 of 6 chairs left
        assert items[chairs["id"]]["sold_quantity"] == 4
        assert items[vase["id"]]["status"] == "sold" and items[rug["id"]]["status"] == "sold"

        workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
        assert workspace["report"]["total_sold_value"] == 135
        assert workspace["summary"]["realized_revenue"] == 135
        assert workspace["report"]["total_remaining_value"] == 30  # two chairs at 15
        breakdown = {row["payment_method"]: row for row in workspace["report"]["payment_breakdown"]}
        assert breakdown["cash"]["total"] == 135

        listed = client.get(f"/api/sales/{sale_id}/orders").json()
        assert [entry["id"] for entry in listed] == [order["id"]]
        assert listed[0]["lines"][1]["quantity"] == 4


def test_checkout_set_total_and_amount_discounts_add_up_to_the_cent() -> None:
    with TestClient(app) as client:
        sale_id = _sale(client, "Set Total Sale")
        ids = [_item(client, sale_id, f"Book {n}", 5)["id"] for n in range(3)]
        order = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={"lines": [{"item_id": item_id} for item_id in ids], "set_total": 10, "payment_method": "venmo"},
        ).json()
        assert order["total"] == 10 and order["discount_total"] == 5
        assert sorted(_event_amounts(client, sale_id, order["id"])) == [3.33, 3.33, 3.34]

        plates = _item(client, sale_id, "Plates", 3.99, quantity=3)
        amount = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={
                "lines": [{"item_id": plates["id"], "quantity": 3}],
                "discount_amount": 1.97,
                "payment_method": "card",
            },
        ).json()
        assert amount["total"] == 10.0 and _event_amounts(client, sale_id, amount["id"]) == [10.0]

        too_high = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={"lines": [{"item_id": _item(client, sale_id, "Mug", 2)["id"]}], "set_total": 3, "payment_method": "cash"},
        )
        assert too_high.status_code == 422


def test_checkout_conflict_names_the_items_and_changes_nothing() -> None:
    with TestClient(app) as client:
        sale_id = _sale(client, "Conflict Sale")
        clock = _item(client, sale_id, "Mantel clock", 25)
        cups = _item(client, sale_id, "Tea cup", 4, quantity=3)
        frame = _item(client, sale_id, "Picture frame", 6)
        assert client.post(f"/api/items/{clock['id']}/sell", json={"payment_method": "cash"}).status_code == 200
        before = _items_by_id(client, sale_id)
        orders_before = client.get(f"/api/sales/{sale_id}/orders").json()

        response = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={
                "lines": [
                    {"item_id": frame["id"]},
                    {"item_id": clock["id"]},
                    {"item_id": cups["id"], "quantity": 5},
                ],
                "payment_method": "cash",
            },
        )
        assert response.status_code == 409
        unavailable = {entry["item_id"]: entry for entry in response.json()["detail"]["unavailable"]}
        assert set(unavailable) == {clock["id"], cups["id"]}
        assert unavailable[clock["id"]]["reason"] == "sold" and unavailable[clock["id"]]["title"] == "Mantel clock"
        assert unavailable[cups["id"]]["remaining"] == 3
        assert _items_by_id(client, sale_id) == before
        assert client.get(f"/api/sales/{sale_id}/orders").json() == orders_before

        other_sale = _sale(client, "Other Estate")
        stranger = _item(client, other_sale, "Somebody else's chair", 10)
        wrong = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={"lines": [{"item_id": frame["id"]}, {"item_id": stranger["id"]}], "payment_method": "cash"},
        )
        assert wrong.status_code == 422
        assert _items_by_id(client, sale_id)[frame["id"]]["status"] == "available"
        assert _items_by_id(client, other_sale)[stranger["id"]]["status"] == "available"

        duplicate = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={"lines": [{"item_id": frame["id"]}, {"item_id": frame["id"]}], "payment_method": "cash"},
        )
        assert duplicate.status_code == 422
        empty = client.post(f"/api/sales/{sale_id}/checkout", json={"lines": [], "payment_method": "cash"})
        assert empty.status_code == 422
        assert client.post("/api/sales/999999/checkout", json={"lines": [{"item_id": frame["id"]}], "payment_method": "cash"}).status_code == 404


def test_void_restores_items_and_totals_and_is_idempotent() -> None:
    with TestClient(app) as client:
        sale_id = _sale(client, "Void Sale")
        desk = _item(client, sale_id, "Oak desk", 120)
        forks = _item(client, sale_id, "Silver fork", 2, quantity=10)
        reserved = _item(client, sale_id, "Held lamp", 15)
        client.patch(f"/api/items/{reserved['id']}/status", json={"status": "reserved"})
        client.post(f"/api/items/{forks['id']}/sell", json={"quantity": 4, "payment_method": "cash"})

        order = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={
                "lines": [{"item_id": desk["id"]}, {"item_id": forks["id"], "quantity": 6}, {"item_id": reserved["id"]}],
                "discount_amount": 10,
                "payment_method": "card",
            },
        ).json()
        assert order["total"] == 120 + 12 + 15 - 10
        sold = client.get(f"/api/sales/{sale_id}/workspace").json()["report"]["total_sold_value"]
        assert sold == 8 + order["total"]

        voided = client.post(f"/api/sales/{sale_id}/orders/{order['id']}/void")
        assert voided.status_code == 200
        body = voided.json()
        assert body["voided"] is True and body["received_total"] == 0
        assert all(line["returned"] for line in body["lines"])
        items = _items_by_id(client, sale_id)
        assert items[desk["id"]]["status"] == "available" and items[desk["id"]]["sale_events"] == []
        assert items[forks["id"]]["status"] == "available" and items[forks["id"]]["sold_quantity"] == 4
        assert items[reserved["id"]]["status"] == "reserved"  # back to how it was
        workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
        assert workspace["report"]["total_sold_value"] == 8
        assert workspace["summary"]["realized_revenue"] == 8

        again = client.post(f"/api/sales/{sale_id}/orders/{order['id']}/void")
        assert again.status_code == 200 and again.json()["voided_at"] == body["voided_at"]
        assert _items_by_id(client, sale_id)[forks["id"]]["sold_quantity"] == 4
        other_sale = _sale(client, "Void Elsewhere")
        assert client.post(f"/api/sales/{other_sale}/orders/{order['id']}/void").status_code == 404

        # The voided order stays listed (marked voided); the earlier single sale is listed too.
        listed = client.get(f"/api/sales/{sale_id}/orders").json()
        assert [entry["voided"] for entry in listed] == [True, False]


def test_single_item_sell_is_recorded_as_an_order_and_undo_removes_it() -> None:
    with TestClient(app) as client:
        sale_id = _sale(client, "Single Sell Sale")
        bowl = _item(client, sale_id, "Mixing bowl", 9, quantity=2)
        sold = client.post(
            f"/api/items/{bowl['id']}/sell", json={"quantity": 1, "unit_price": 7, "payment_method": "zelle"}
        ).json()
        event = sold["sale_events"][0]
        orders = client.get(f"/api/sales/{sale_id}/orders").json()
        assert len(orders) == 1 and orders[0]["id"] == event["order_id"]
        assert orders[0]["total"] == 7 and orders[0]["payment_method"] == "zelle"
        assert orders[0]["lines"][0]["title"] == "Mixing bowl"

        # Correcting how it was paid keeps the order in step.
        client.patch(f"/api/items/{bowl['id']}/payment-method", json={"payment_method": "cash"})
        assert client.get(f"/api/sales/{sale_id}/orders").json()[0]["payment_method"] == "cash"

        undone = client.post(f"/api/items/{bowl['id']}/unsell", json={"event_id": event["id"]})
        assert undone.status_code == 200 and undone.json()["sold_quantity"] == 0
        assert client.get(f"/api/sales/{sale_id}/orders").json() == []

        # A line removed some other way (status back to available) shows as returned.
        cart = client.post(
            f"/api/sales/{sale_id}/checkout",
            json={"lines": [{"item_id": bowl["id"], "quantity": 2}, {"item_id": _item(client, sale_id, "Whisk", 3)["id"]}],
                  "payment_method": "cash"},
        ).json()
        client.patch(f"/api/items/{bowl['id']}/status", json={"status": "available"})
        listed = client.get(f"/api/sales/{sale_id}/orders").json()[0]
        assert listed["id"] == cart["id"]
        assert [line["returned"] for line in listed["lines"]] == [True, False]
        assert listed["received_total"] == 3 and listed["total"] == 21


def test_order_list_uses_a_constant_number_of_queries() -> None:
    from sqlalchemy import event

    from backend.config.database import database

    with TestClient(app) as client:
        sale_id = _sale(client, "Query Count Sale")

        def count_queries() -> int:
            statements: list[str] = []

            def record(*args: object) -> None:
                statements.append(str(args[2]))

            event.listen(database.engine, "before_cursor_execute", record)
            try:
                assert client.get(f"/api/sales/{sale_id}/orders").status_code == 200
            finally:
                event.remove(database.engine, "before_cursor_execute", record)
            return len(statements)

        client.post(f"/api/items/{_item(client, sale_id, 'Pan', 5)['id']}/sell", json={"payment_method": "cash"})
        one = count_queries()
        for n in range(4):
            client.post(f"/api/items/{_item(client, sale_id, f'Pot {n}', 5)['id']}/sell", json={"payment_method": "cash"})
        assert count_queries() == one


def test_order_column_is_added_to_an_old_sale_rows_table_without_touching_rows(tmp_path: Path) -> None:
    """An itemsaleevent table from before checkouts gains a nullable order_id; its rows are kept."""

    import sqlite3

    from sqlmodel import Session, SQLModel, create_engine, select

    from backend.config.database import ensure_item_quantity_column, ensure_item_sale_event_order_column
    from backend.core.models import Item
    from backend.core.selling import load_sale_events, sold_fields

    db_path = tmp_path / "old-events.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "CREATE TABLE item (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL, category_id INTEGER,"
            " title VARCHAR NOT NULL, description VARCHAR NOT NULL DEFAULT '', room VARCHAR NOT NULL DEFAULT 'General',"
            " condition VARCHAR NOT NULL DEFAULT 'Good', price FLOAT, quantity INTEGER NOT NULL DEFAULT 1,"
            " status VARCHAR NOT NULL, notes VARCHAR NOT NULL DEFAULT '', photo_url VARCHAR, created_at DATETIME NOT NULL)"
        )
        connection.execute(
            "CREATE TABLE itemsaleevent (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, quantity INTEGER NOT NULL,"
            " amount FLOAT NOT NULL, payment_method VARCHAR(20), status_before VARCHAR(20) NOT NULL, sold_at DATETIME)"
        )
        connection.execute(
            "INSERT INTO item (id, sale_id, title, price, quantity, status, created_at)"
            " VALUES (1, 1, 'Old chairs', 10, 4, 'AVAILABLE', '2026-01-01 00:00:00')"
        )
        connection.execute(
            "INSERT INTO itemsaleevent (id, item_id, quantity, amount, payment_method, status_before, sold_at)"
            " VALUES (7, 1, 2, 18.5, 'cash', 'available', '2026-10-01 15:00:00')"
        )

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        SQLModel.metadata.create_all(engine)
        ensure_item_quantity_column(engine)
        assert ensure_item_sale_event_order_column(engine) is True
        assert ensure_item_sale_event_order_column(engine) is False
        with Session(engine) as session:
            item = session.exec(select(Item)).one()
            fields = sold_fields(item, load_sale_events(session, [1]).get(1, []))
    finally:
        engine.dispose()

    assert fields["sold_quantity"] == 2 and fields["sold_total"] == 18.5
    assert fields["sale_events"][0]["order_id"] is None
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute("SELECT id, item_id, quantity, amount, payment_method, order_id FROM itemsaleevent").fetchall()
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        indexes = {row[1] for row in connection.execute("PRAGMA index_list('itemsaleevent')")}
    assert rows == [(7, 1, 2, 18.5, "cash", None)]
    assert "customer_order" in tables
    assert "ix_itemsaleevent_order_id" in indexes


def test_order_column_migration_never_raises() -> None:
    from sqlmodel import create_engine

    from backend.config.database import ensure_item_sale_event_order_column

    assert ensure_item_sale_event_order_column(create_engine("sqlite:///Z:/definitely/missing/dir/nope.db")) is False
