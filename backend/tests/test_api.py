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
    assert len(selects) <= 3  # items, main photo versions, extra photo counts


def _add_photo(client: TestClient, item_id: int, data: bytes = JPEG_BYTES, content_type: str = "image/jpeg"):
    return client.post(
        f"/api/items/{item_id}/photos",
        files={"photo": ("photo", data, content_type)},
    )


def test_item_can_have_several_photos_listed_fetched_and_deleted() -> None:
    """Photos added to an item are listed main-first, served, and removable one by one."""

    with TestClient(app) as client:
        _, item_id = _create_sale_and_item(client)
        assert client.get(f"/api/items/{item_id}/photos").json() == []

        first = _add_photo(client, item_id, JPEG_BYTES, "image/jpeg")
        assert first.status_code == 200
        assert first.json()["photo_count"] == 1
        main_version = first.json()["photo_version"]
        assert main_version
        second = _add_photo(client, item_id, PNG_BYTES, "image/png")
        third = _add_photo(client, item_id, b"RIFF" + b"\x01" * 40, "image/webp")
        assert third.json()["photo_count"] == 3
        # Adding extra photos never changes the main photo.
        assert second.json()["photo_version"] == main_version == third.json()["photo_version"]

        photos = client.get(f"/api/items/{item_id}/photos").json()
        assert [photo["is_main"] for photo in photos] == [True, False, False]
        assert photos[0]["id"] is None
        assert all("data" not in photo for photo in photos)

        assert client.get(f"/api/items/{item_id}/photo").content == JPEG_BYTES
        extra = client.get(f"/api/items/{item_id}/photos/{photos[1]['id']}")
        assert extra.status_code == 200
        assert extra.content == PNG_BYTES
        assert extra.headers["content-type"] == "image/png"
        assert "max-age" in extra.headers["cache-control"]

        deleted = client.delete(f"/api/items/{item_id}/photos/{photos[1]['id']}")
        assert deleted.status_code == 200
        assert deleted.json()["photo_count"] == 2
        assert client.get(f"/api/items/{item_id}/photos/{photos[1]['id']}").status_code == 404

        # Removing the main photo promotes the next one instead of losing it.
        removed_main = client.delete(f"/api/items/{item_id}/photo")
        assert removed_main.json()["photo_count"] == 1
        assert removed_main.json()["photo_version"] is not None
        assert client.get(f"/api/items/{item_id}/photo").content.startswith(b"RIFF")
        assert len(client.get(f"/api/items/{item_id}/photos").json()) == 1


def test_set_main_photo_swaps_and_changes_the_thumbnail_version() -> None:
    """Choosing another main photo swaps it with the old main, keeping both photos."""

    with TestClient(app) as client:
        sale_id, item_id = _create_sale_and_item(client)
        _add_photo(client, item_id, JPEG_BYTES, "image/jpeg")
        _add_photo(client, item_id, PNG_BYTES, "image/png")
        before = client.get(f"/api/items/{item_id}/photos").json()
        extra_id = before[1]["id"]

        result = client.post(f"/api/items/{item_id}/photos/{extra_id}/main")
        assert result.status_code == 200
        assert result.json()["photo_count"] == 2
        assert result.json()["photo_version"] != before[0]["version"]

        assert client.get(f"/api/items/{item_id}/photo").content == PNG_BYTES
        assert client.get(f"/api/items/{item_id}/photos/{extra_id}").content == JPEG_BYTES
        after = client.get(f"/api/items/{item_id}/photos").json()
        assert after[1]["version"] != before[1]["version"]

        listed = client.get(f"/api/sales/{sale_id}/workspace").json()["items"][0]
        assert listed["photo_version"] == result.json()["photo_version"]

        assert client.post(f"/api/items/{item_id}/photos/999999/main").status_code == 404


def test_item_photos_enforce_cap_type_size_and_missing_items() -> None:
    """The photo gallery validates like the single photo and caps photos per item."""

    from backend.main import MAX_PHOTOS_PER_ITEM

    with TestClient(app) as client:
        _, item_id = _create_sale_and_item(client)
        _, other_item_id = _create_sale_and_item(client)

        bad_type = _add_photo(client, item_id, b"hello", "text/plain")
        assert bad_type.status_code == 400
        assert "JPG" in bad_type.json()["detail"]
        too_large = _add_photo(client, item_id, b"\xff" * (1024 * 1024 + 1), "image/jpeg")
        assert too_large.status_code == 413
        assert "1 MB" in too_large.json()["detail"]
        assert _add_photo(client, 999999).status_code == 404
        assert client.get("/api/items/999999/photos").status_code == 404

        for _ in range(MAX_PHOTOS_PER_ITEM):
            assert _add_photo(client, item_id).status_code == 200
        capped = _add_photo(client, item_id)
        assert capped.status_code == 400
        assert str(MAX_PHOTOS_PER_ITEM) in capped.json()["detail"]

        # A photo id that belongs to another item is not reachable through this one.
        extra_id = client.get(f"/api/items/{item_id}/photos").json()[1]["id"]
        assert client.get(f"/api/items/{other_item_id}/photos/{extra_id}").status_code == 404
        assert client.delete(f"/api/items/{other_item_id}/photos/{extra_id}").status_code == 404


def test_old_single_photo_is_still_served_and_counted() -> None:
    """A photo stored the old way (PUT /photo) stays the main photo and counts once."""

    with TestClient(app) as client:
        sale_id, item_id = _create_sale_and_item(client)
        client.put(f"/api/items/{item_id}/photo", files={"photo": ("lamp.jpg", JPEG_BYTES, "image/jpeg")})
        listed = client.get(f"/api/sales/{sale_id}/workspace").json()["items"][0]
        assert listed["photo_count"] == 1
        assert listed["photo_version"]
        photos = client.get(f"/api/items/{item_id}/photos").json()
        assert photos == [{"id": None, "is_main": True, "version": listed["photo_version"]}]
        assert client.get(f"/api/items/{item_id}/photo").content == JPEG_BYTES
        added = _add_photo(client, item_id, PNG_BYTES, "image/png")
        assert added.json()["photo_count"] == 2
        assert added.json()["photo_version"] == listed["photo_version"]


def test_item_lists_report_photo_counts_in_a_bounded_number_of_queries() -> None:
    """Listing items carries photo counts without one query per item."""

    from sqlalchemy import event

    from backend.config.database import database

    statements: list[str] = []

    def count_statement(*_args) -> None:
        statements.append("q")

    with TestClient(app) as client:
        sale_id, item_id = _create_sale_and_item(client)
        _add_photo(client, item_id)
        _add_photo(client, item_id)

        def measure(path: str) -> int:
            statements.clear()
            event.listen(database.engine, "before_cursor_execute", count_statement)
            try:
                assert client.get(path).status_code == 200
            finally:
                event.remove(database.engine, "before_cursor_execute", count_statement)
            return len(statements)

        workspace_small = measure(f"/api/sales/{sale_id}/workspace")
        all_small = measure("/api/items")
        for index in range(6):
            new_id = client.post("/api/items", json={"sale_id": sale_id, "title": f"Chair {index}"}).json()["id"]
            _add_photo(client, new_id)
            _add_photo(client, new_id)
        assert measure(f"/api/sales/{sale_id}/workspace") == workspace_small
        assert measure("/api/items") == all_small

        counts = {item["id"]: item["photo_count"] for item in client.get("/api/items").json()}
        assert counts[item_id] == 2
        workspace_counts = {
            item["id"]: item["photo_count"] for item in client.get(f"/api/sales/{sale_id}/workspace").json()["items"]
        }
        assert list(workspace_counts.values()).count(2) == 7


def test_gallery_table_is_added_without_touching_existing_photos(tmp_path: Path) -> None:
    """`create_all` on a database with old single photos adds the gallery table and keeps them."""

    import sqlite3

    from sqlmodel import SQLModel, create_engine

    db_path = tmp_path / "old-photos.db"
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE item (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL, title VARCHAR NOT NULL)")
        connection.execute(
            "CREATE TABLE itemphoto (item_id INTEGER PRIMARY KEY, content_type VARCHAR(40) NOT NULL,"
            " data BLOB NOT NULL, updated_at DATETIME NOT NULL)"
        )
        connection.execute("INSERT INTO item (id, sale_id, title) VALUES (1, 1, 'Old lamp')")
        connection.execute(
            "INSERT INTO itemphoto VALUES (1, 'image/jpeg', ?, '2026-01-01 00:00:00')", (JPEG_BYTES,)
        )

    engine = create_engine(f"sqlite:///{db_path}")
    try:
        SQLModel.metadata.create_all(engine)
    finally:
        engine.dispose()

    with sqlite3.connect(db_path) as connection:
        assert connection.execute("SELECT item_id, data FROM itemphoto").fetchall() == [(1, JPEG_BYTES)]
        assert connection.execute("SELECT COUNT(*) FROM itemgalleryphoto").fetchone() == (0,)


def test_delete_item_removes_it_and_all_its_photos_with_foreign_keys_enforced() -> None:
    """Deleting an item removes its main and extra photos too, and never trips a foreign key."""

    import pytest
    from sqlalchemy import event
    from sqlalchemy.exc import IntegrityError
    from sqlmodel import Session

    from backend.config.database import database
    from backend.core.models import Item, ItemGalleryPhoto, ItemPhoto

    def enable_foreign_keys(dbapi_connection, _record) -> None:
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    event.listen(database.engine, "connect", enable_foreign_keys)
    database.engine.dispose()
    try:
        with TestClient(app) as client:
            sale_id, item_id = _create_sale_and_item(client)
            other_id = client.post(
                "/api/items", json={"sale_id": sale_id, "title": "Oak table", "price": 40}
            ).json()["id"]
            client.patch(f"/api/items/{item_id}", json={"price": 15})
            _add_photo(client, item_id, JPEG_BYTES, "image/jpeg")
            _add_photo(client, item_id, PNG_BYTES, "image/png")
            _add_photo(client, other_id, PNG_BYTES, "image/png")
            extra_id = client.get(f"/api/items/{item_id}/photos").json()[1]["id"]

            # Foreign keys really are enforced: a bare delete of an item with photos fails.
            with Session(database.engine) as session:
                with pytest.raises(IntegrityError):
                    session.delete(session.get(Item, item_id))
                    session.commit()

            def sale_summary() -> dict:
                return next(
                    sale for sale in client.get("/api/dashboard").json()["sales"] if sale["id"] == sale_id
                )

            assert sale_summary()["item_count"] == 2

            deleted = client.delete(f"/api/items/{item_id}")
            assert deleted.status_code == 204

            assert client.get(f"/api/items/{item_id}/photo").status_code == 404
            assert client.get(f"/api/items/{item_id}/photos/{extra_id}").status_code == 404
            assert client.get(f"/api/items/{item_id}/photos").status_code == 404
            workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
            assert [item["id"] for item in workspace["items"]] == [other_id]
            assert sale_summary()["item_count"] == 1
            assert item_id not in {item["id"] for item in client.get("/api/items").json()}

            # The other item and its photo are untouched.
            assert workspace["items"][0]["photo_count"] == 1
            assert client.get(f"/api/items/{other_id}/photo").content == PNG_BYTES
            with Session(database.engine) as session:
                assert session.get(ItemPhoto, item_id) is None
                assert session.get(ItemGalleryPhoto, extra_id) is None

            assert client.delete(f"/api/items/{item_id}").status_code == 404
            assert client.delete("/api/items/999999").status_code == 404
    finally:
        event.remove(database.engine, "connect", enable_foreign_keys)
        database.engine.dispose()


def test_status_endpoint_changes_only_the_status() -> None:
    """PATCH /items/{id}/status changes status alone, so a stale full copy elsewhere is never replayed."""

    with TestClient(app) as client:
        sale_id = client.post(
            "/api/sales",
            json={"title": "Status Sale", "start_date": "2026-10-01", "end_date": "2026-10-02"},
        ).json()["id"]
        item = client.post(
            "/api/items",
            json={"sale_id": sale_id, "title": "Oak desk", "price": 80, "quantity": 2, "notes": "old"},
        ).json()
        # Another tab edits the notes and price after this tab loaded the item.
        client.patch(f"/api/items/{item['id']}", json={"title": "Oak desk", "price": 95, "quantity": 2, "notes": "new"})

        sold = client.patch(f"/api/items/{item['id']}/status", json={"status": "sold"})
        assert sold.status_code == 200
        body = sold.json()
        assert body["status"] == "sold"
        assert body["notes"] == "new"
        assert body["price"] == 95
        assert body["quantity"] == 2

        workspace = client.get(f"/api/sales/{sale_id}/workspace").json()
        assert workspace["report"]["total_sold_value"] == 190

        back = client.patch(f"/api/items/{item['id']}/status", json={"status": "available"})
        assert back.json()["status"] == "available"
        assert client.patch(f"/api/items/{item['id']}/status", json={"status": "bogus"}).status_code == 422
        assert client.patch(f"/api/items/{item['id']}/status", json={}).status_code == 422
        assert client.patch("/api/items/999999/status", json={"status": "sold"}).status_code == 404


def test_quantity_decrement_undoes_an_increment_and_never_goes_below_one() -> None:
    """POST /items/{id}/quantity/decrement takes quantity back, floored at 1, touching nothing else."""

    with TestClient(app) as client:
        sale_id = client.post(
            "/api/sales",
            json={"title": "Undo Sale", "start_date": "2026-10-01", "end_date": "2026-10-02"},
        ).json()["id"]
        item = client.post(
            "/api/items", json={"sale_id": sale_id, "title": "Teacup", "price": 4, "notes": "keep"}
        ).json()
        assert client.post(f"/api/items/{item['id']}/quantity/increment", json={"amount": 3}).json()["quantity"] == 4

        undone = client.post(f"/api/items/{item['id']}/quantity/decrement", json={"amount": 3})
        assert undone.status_code == 200
        assert undone.json()["quantity"] == 1
        assert undone.json()["notes"] == "keep"
        assert client.post(f"/api/items/{item['id']}/quantity/decrement", json={"amount": 5}).json()["quantity"] == 1
        assert client.post(f"/api/items/{item['id']}/quantity/decrement", json={"amount": 0}).status_code == 422
        assert client.post("/api/items/999999/quantity/decrement", json={"amount": 1}).status_code == 404
