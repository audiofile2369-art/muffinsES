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
