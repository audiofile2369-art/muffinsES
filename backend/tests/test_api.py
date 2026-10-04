"""API smoke tests for the estate sales manager backend."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi.testclient import TestClient

TEST_DATABASE_PATH = Path(__file__).resolve().parents[2] / "data" / "test-api.db"
TEST_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
if TEST_DATABASE_PATH.exists():
    TEST_DATABASE_PATH.unlink()
os.environ["MUFFINES_DATABASE_PATH"] = str(TEST_DATABASE_PATH)

from backend.main import app


def test_health_endpoint() -> None:
    """The health endpoint should return an ok status."""

    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_dashboard_starts_empty() -> None:
    """The dashboard should start empty with no seeded sales."""

    with TestClient(app) as client:
        response = client.get("/api/dashboard")

    body = response.json()
    assert response.status_code == 200
    assert body["sales"] == []


def test_can_create_sale_and_load_workspace() -> None:
    """A created sale should load an empty workspace payload."""

    with TestClient(app) as client:
        create_response = client.post(
            "/api/sales",
            json={
                "title": "Amanda Starter Sale",
                "address": "12 Starter Lane",
                "start_date": "2026-07-01",
                "end_date": "2026-07-03",
                "status": "planning",
                "notes": "Initial clean slate sale.",
            },
        )
        sale_id = create_response.json()["id"]
        workspace_response = client.get(f"/api/sales/{sale_id}/workspace")

    body = workspace_response.json()
    assert create_response.status_code == 200
    assert workspace_response.status_code == 200
    assert body["sale"]["id"] == sale_id
    assert body["items"] == []
    assert body["tasks"] == []
    assert body["report"]["total_items"] == 0


def test_partial_sale_patch_preserves_optional_fields() -> None:
    """A partial sale patch should not blank out omitted optional fields."""

    with TestClient(app) as client:
        create_response = client.post(
            "/api/sales",
            json={
                "title": "Patchable Sale",
                "address": "45 Notes Avenue",
                "start_date": "2026-08-10",
                "end_date": "2026-08-11",
                "status": "ready",
                "notes": "Keep these details intact.",
            },
        )
        sale = create_response.json()

        patch_response = client.patch(
            f"/api/sales/{sale['id']}",
            json={
                "title": sale["title"],
                "start_date": sale["start_date"],
                "end_date": sale["end_date"],
                "status": sale["status"],
            },
        )

    body = patch_response.json()
    assert patch_response.status_code == 200
    assert body["address"] == sale["address"]
    assert body["notes"] == sale["notes"]


JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _create_sale_and_item(client: TestClient) -> tuple[int, int]:
    sale_id = client.post(
        "/api/sales",
        json={
            "title": "Photo Sale",
            "start_date": "2026-08-01",
            "end_date": "2026-08-02",
        },
    ).json()["id"]
    item_response = client.post("/api/items", json={"sale_id": sale_id, "title": "Brass lamp"})
    assert item_response.status_code == 200
    assert item_response.json()["photo_version"] is None
    return sale_id, item_response.json()["id"]


def test_item_photo_upload_fetch_replace_and_delete() -> None:
    """A stored item photo can be uploaded, fetched, replaced and removed."""

    with TestClient(app) as client:
        sale_id, item_id = _create_sale_and_item(client)

        missing = client.get(f"/api/items/{item_id}/photo")
        assert missing.status_code == 404

        upload = client.put(
            f"/api/items/{item_id}/photo",
            files={"photo": ("lamp.jpg", JPEG_BYTES, "image/jpeg")},
        )
        assert upload.status_code == 200
        first_version = upload.json()["photo_version"]
        assert first_version

        fetched = client.get(f"/api/items/{item_id}/photo")
        assert fetched.status_code == 200
        assert fetched.content == JPEG_BYTES
        assert fetched.headers["content-type"] == "image/jpeg"
        assert "max-age" in fetched.headers["cache-control"]

        workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
        listed = next(item for item in workspace["items"] if item["id"] == item_id)
        assert listed["photo_version"] == first_version

        replaced = client.put(
            f"/api/items/{item_id}/photo",
            files={"photo": ("lamp.png", PNG_BYTES, "image/png")},
        )
        assert replaced.status_code == 200
        assert replaced.json()["photo_version"] != first_version
        refetched = client.get(f"/api/items/{item_id}/photo")
        assert refetched.content == PNG_BYTES
        assert refetched.headers["content-type"] == "image/png"

        patched = client.patch(f"/api/items/{item_id}", json={"title": "Brass lamp", "price": 12})
        assert patched.status_code == 200, patched.text
        assert patched.json()["photo_version"] == replaced.json()["photo_version"]

        deleted = client.delete(f"/api/items/{item_id}/photo")
        assert deleted.status_code == 200
        assert deleted.json()["photo_version"] is None
        assert client.get(f"/api/items/{item_id}/photo").status_code == 404
        workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
        listed = next(item for item in workspace["items"] if item["id"] == item_id)
        assert listed["photo_version"] is None


def test_item_photo_rejects_bad_type_large_files_and_missing_items() -> None:
    """Uploads must be a supported image type, under 1 MB, for a real item."""

    with TestClient(app) as client:
        _, item_id = _create_sale_and_item(client)

        bad_type = client.put(
            f"/api/items/{item_id}/photo",
            files={"photo": ("notes.txt", b"hello", "text/plain")},
        )
        assert bad_type.status_code == 400

        too_large = client.put(
            f"/api/items/{item_id}/photo",
            files={"photo": ("big.jpg", b"\xff" * (1024 * 1024 + 1), "image/jpeg")},
        )
        assert too_large.status_code == 413
        assert "1 MB" in too_large.json()["detail"]

        missing_item = client.put(
            "/api/items/999999/photo",
            files={"photo": ("lamp.jpg", JPEG_BYTES, "image/jpeg")},
        )
        assert missing_item.status_code == 404
        assert client.delete("/api/items/999999/photo").status_code == 404
        assert client.get(f"/api/items/{item_id}/photo").status_code == 404


def test_item_quantity_defaults_increments_and_counts_in_totals() -> None:
    """Quantity defaults to 1, increments in place, and multiplies item value in totals."""

    with TestClient(app) as client:
        sale_id = client.post(
            "/api/sales",
            json={"title": "Quantity Sale", "start_date": "2026-09-01", "end_date": "2026-09-02"},
        ).json()["id"]
        chair = client.post("/api/items", json={"sale_id": sale_id, "title": "Dining chair", "price": 20})
        assert chair.status_code == 200
        assert chair.json()["quantity"] == 1
        chair_id = chair.json()["id"]
        client.post(
            "/api/items",
            json={"sale_id": sale_id, "title": "Vase", "price": 5, "quantity": 3, "status": "sold"},
        )

        bumped = client.post(f"/api/items/{chair_id}/quantity/increment", json={"amount": 2})
        assert bumped.status_code == 200
        assert bumped.json()["quantity"] == 3
        assert bumped.json()["title"] == "Dining chair"
        assert client.post(f"/api/items/{chair_id}/quantity/increment", json={}).json()["quantity"] == 4
        assert client.post(f"/api/items/{chair_id}/quantity/increment", json={"amount": 0}).status_code == 422
        assert client.post("/api/items/999999/quantity/increment", json={"amount": 1}).status_code == 404
        assert client.post("/api/items", json={"sale_id": sale_id, "title": "Bad", "quantity": 0}).status_code == 422

        edited = client.patch(f"/api/items/{chair_id}", json={"title": "Dining chair", "price": 20})
        assert edited.json()["quantity"] == 4

        workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
        assert len(workspace["items"]) == 2
        report = workspace["report"]
        assert report["total_listed_value"] == 4 * 20 + 3 * 5
        assert report["total_sold_value"] == 3 * 5
        assert workspace["summary"]["estimated_revenue"] == 95
        assert workspace["summary"]["realized_revenue"] == 15


def test_quantity_migration_adds_column_to_old_item_table(tmp_path: Path) -> None:
    """An item table created before `quantity` existed gains it with value 1, keeping rows."""

    import sqlite3

    from sqlmodel import create_engine

    from backend.config.database import ensure_item_quantity_column

    db_path = tmp_path / "old.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "CREATE TABLE item (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL, title VARCHAR NOT NULL, price FLOAT)"
        )
        connection.execute("INSERT INTO item (id, sale_id, title, price) VALUES (1, 1, 'Old lamp', 12.5)")

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        assert ensure_item_quantity_column(engine) is True
        assert ensure_item_quantity_column(engine) is False
    finally:
        engine.dispose()

    with sqlite3.connect(db_path) as connection:
        rows = connection.execute("SELECT id, title, price, quantity FROM item").fetchall()
    assert rows == [(1, "Old lamp", 12.5, 1)]


def test_quantity_migration_never_raises() -> None:
    """A broken database connection must not crash startup."""

    from sqlmodel import create_engine

    from backend.config.database import ensure_item_quantity_column

    engine = create_engine("sqlite:///Z:/definitely/missing/dir/nope.db")
    assert ensure_item_quantity_column(engine) is False


def test_all_items_lists_every_sale_with_names_and_photo_versions() -> None:
    """GET /api/items returns items from every sale in a constant number of queries."""

    from sqlalchemy import event

    from backend.config.database import database

    with TestClient(app) as client:
        first_sale = client.post(
            "/api/sales",
            json={"title": "All Items North", "start_date": "2026-09-01", "end_date": "2026-09-02"},
        ).json()["id"]
        second_sale = client.post(
            "/api/sales",
            json={"title": "All Items South", "start_date": "2026-09-03", "end_date": "2026-09-04"},
        ).json()["id"]
        category_id = client.post("/api/categories", json={"name": "All Items Lamps"}).json()["id"]
        created_ids = []
        for index in range(6):
            sale_id = first_sale if index % 2 == 0 else second_sale
            response = client.post(
                "/api/items",
                json={
                    "sale_id": sale_id,
                    "title": f"All items thing {index}",
                    "category_id": category_id if index == 0 else None,
                },
            )
            assert response.status_code == 200
            created_ids.append(response.json()["id"])
        photo = client.put(
            f"/api/items/{created_ids[0]}/photo",
            files={"photo": ("lamp.jpg", JPEG_BYTES, "image/jpeg")},
        )
        assert photo.status_code == 200

        statements: list[str] = []

        def count_statement(*args: object) -> None:
            statements.append(str(args[2]))

        event.listen(database.engine, "before_cursor_execute", count_statement)
        try:
            response = client.get("/api/items")
        finally:
            event.remove(database.engine, "before_cursor_execute", count_statement)

    assert response.status_code == 200
    body = {item["id"]: item for item in response.json()}
    assert set(created_ids) <= set(body)
    assert body[created_ids[0]]["sale_title"] == "All Items North"
    assert body[created_ids[1]]["sale_title"] == "All Items South"
    assert body[created_ids[0]]["category_name"] == "All Items Lamps"
    assert body[created_ids[1]]["category_name"] is None
    assert body[created_ids[0]]["photo_version"]
    assert body[created_ids[1]]["photo_version"] is None
    assert "created_at" in body[created_ids[0]]
    assert all("photo_data" not in item and "data" not in item for item in body.values())
    selects = [sql for sql in statements if sql.lstrip().upper().startswith("SELECT")]
    assert len(selects) <= 2
