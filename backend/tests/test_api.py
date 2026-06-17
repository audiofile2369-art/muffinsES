"""API smoke tests for the estate sales manager backend."""

from __future__ import annotations

from fastapi.testclient import TestClient

from backend.main import app


def test_health_endpoint() -> None:
    """The health endpoint should return an ok status."""

    with TestClient(app) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_dashboard_returns_seeded_sales() -> None:
    """The dashboard should return the seeded sample sales."""

    with TestClient(app) as client:
        response = client.get("/api/dashboard")

    body = response.json()
    assert response.status_code == 200
    assert len(body["sales"]) >= 2
    assert any(sale["item_count"] > 0 for sale in body["sales"])


def test_workspace_returns_items_tasks_and_reports() -> None:
    """The workspace response should include the main sale management payload."""

    with TestClient(app) as client:
        dashboard_response = client.get("/api/dashboard")
        first_sale_id = dashboard_response.json()["sales"][0]["id"]
        workspace_response = client.get(f"/api/sales/{first_sale_id}/workspace")

    body = workspace_response.json()
    assert workspace_response.status_code == 200
    assert body["sale"]["id"] == first_sale_id
    assert isinstance(body["items"], list)
    assert isinstance(body["tasks"], list)
    assert "sell_through_rate" in body["report"]


def test_partial_sale_patch_preserves_optional_fields() -> None:
    """A partial sale patch should not blank out omitted optional fields."""

    with TestClient(app) as client:
        dashboard_response = client.get("/api/dashboard")
        first_sale = dashboard_response.json()["sales"][0]
        workspace_response = client.get(f"/api/sales/{first_sale['id']}/workspace")
        sale = workspace_response.json()["sale"]

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
