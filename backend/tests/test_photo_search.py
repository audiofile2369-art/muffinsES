"""Tests for search-by-photo with the OpenAI client mocked out."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

TEST_DATABASE_PATH = Path(__file__).resolve().parents[2] / "data" / "test-photo-search.db"
TEST_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MUFFINES_DATABASE_PATH", str(TEST_DATABASE_PATH))

from backend.core import pricing
from backend.core.photo_search import (
    MAX_IMAGE_CANDIDATES,
    MAX_TEXT_ONLY_CANDIDATES,
    PhotoDescription,
    SearchableItem,
    select_candidates,
)
from backend.core.pricing import PricingEstimateService
from backend.main import app

JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"

DESCRIPTION = {
    "object_type": "table lamp",
    "summary": "A brass table lamp with a green glass shade.",
    "materials": ["brass", "glass"],
    "colors": ["green", "gold"],
    "distinguishing_features": ["banker style shade"],
    "keywords": ["lamp", "banker", "desk lamp"],
}


class SequenceResponses:
    """Stand-in for `client.responses` returning one queued payload per call."""

    def __init__(self, payloads: list[dict[str, object]] | None = None, error: Exception | None = None) -> None:
        self.payloads = list(payloads or [])
        self.error = error
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> SimpleNamespace:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(output_text=json.dumps(self.payloads.pop(0)))


def install_fake(monkeypatch: pytest.MonkeyPatch, fake: SequenceResponses) -> None:
    service = PricingEstimateService(client=SimpleNamespace(responses=fake), model="test-model")
    monkeypatch.setattr(pricing.PricingEstimateService, "from_settings", classmethod(lambda cls: service))


def images_in(call: dict[str, object]) -> list[dict[str, object]]:
    content = call["input"][0]["content"]  # type: ignore[index]
    return [part for part in content if part["type"] == "input_image"]


def texts_in(call: dict[str, object]) -> str:
    content = call["input"][0]["content"]  # type: ignore[index]
    return "\n".join(part["text"] for part in content if part["type"] == "input_text")


def make_sale(client: TestClient, title: str) -> int:
    return client.post(
        "/api/sales", json={"title": title, "start_date": "2026-09-01", "end_date": "2026-09-02"}
    ).json()["id"]


def make_item(client: TestClient, sale_id: int, title: str, photo: bool = True, **fields: object) -> int:
    item_id = client.post("/api/items", json={"sale_id": sale_id, "title": title, **fields}).json()["id"]
    if photo:
        response = client.post(
            f"/api/items/{item_id}/photos", files={"photo": ("p.jpg", JPEG_BYTES, "image/jpeg")}
        )
        assert response.status_code == 200
    return item_id


def search(client: TestClient, sale_id: int | None = None) -> httpx.Response:
    data = {"sale_id": str(sale_id)} if sale_id is not None else {}
    return client.post(
        "/api/items/search-by-photo",
        files={"photo": ("query.jpg", JPEG_BYTES, "image/jpeg")},
        data=data,
    )


def test_select_candidates_ranks_by_text_and_caps_images_and_text_only() -> None:
    """The best text matches with photos fill the image slots; a few text-only items follow."""

    description = PhotoDescription(**DESCRIPTION)
    items = [SearchableItem(id=index, title=f"Garden chair {index}", has_photo=True) for index in range(20)]
    items.append(SearchableItem(id=100, title="Brass banker lamp", description="green glass shade", has_photo=True))
    items += [SearchableItem(id=200 + index, title=f"Desk lamp {index}") for index in range(6)]
    items.append(SearchableItem(id=300, title="Toaster"))

    chosen = select_candidates(description, items)
    with_photo = [item for item in chosen if item.has_photo]
    text_only = [item for item in chosen if not item.has_photo]
    assert with_photo[0].id == 100
    assert len(with_photo) == MAX_IMAGE_CANDIDATES
    assert len(text_only) == MAX_TEXT_ONLY_CANDIDATES
    assert all(item.id != 300 for item in chosen)  # no overlap and no photo: never a candidate


def test_search_returns_only_candidate_items_ranked_by_confidence(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unknown labels, raw ids, duplicates and bad confidences from the model are ignored."""

    with TestClient(app) as client:
        sale_id = make_sale(client, "Lamp Sale")
        lamp_id = make_item(client, sale_id, "Brass banker lamp", description="green glass shade", price=40)
        make_item(client, sale_id, "Garden chair")
        rug_id = make_item(client, sale_id, "Green lamp rug", photo=False)

        fake = SequenceResponses(
            [
                DESCRIPTION,
                {
                    "matches": [
                        {"candidate": "C3", "confidence": "low", "reason": "text only"},
                        {"candidate": "C99", "confidence": "high", "reason": "not a candidate"},
                        {"candidate": str(lamp_id), "confidence": "high", "reason": "raw id"},
                        {"candidate": "C1", "confidence": "high", "reason": "same lamp"},
                        {"candidate": "c1", "confidence": "medium", "reason": "duplicate"},
                        {"candidate": "C2", "confidence": "certain", "reason": "bad confidence"},
                    ]
                },
            ]
        )
        install_fake(monkeypatch, fake)
        response = search(client, sale_id)

    assert response.status_code == 200
    body = response.json()
    assert [(match["item"]["id"], match["confidence"]) for match in body["matches"]] == [
        (lamp_id, "high"),
        (rug_id, "low"),
    ]
    first = body["matches"][0]["item"]
    assert first["sale_title"] == "Lamp Sale"
    assert first["price"] == 40
    assert first["photo_version"]
    assert body["summary"] == DESCRIPTION["summary"]
    assert body["candidates_considered"] == 3

    assert len(fake.calls) == 2
    compare_call = fake.calls[1]
    # Query photo + one low-detail image per candidate with a photo.
    assert len(images_in(compare_call)) == 3
    assert all(image.get("detail") == "low" for image in images_in(compare_call)[1:])
    assert "C1: Brass banker lamp" in texts_in(compare_call)
    assert "(no saved photo)" in texts_in(compare_call)
    assert all(call.get("timeout") for call in fake.calls)


def test_search_is_scoped_to_the_sale_and_caps_images(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the chosen sale's items are candidates, and never more than 8 candidate photos."""

    with TestClient(app) as client:
        sale_id = make_sale(client, "Big Sale")
        other_sale_id = make_sale(client, "Other Sale")
        for index in range(MAX_IMAGE_CANDIDATES + 3):
            make_item(client, sale_id, f"Brass lamp {index}")
        make_item(client, other_sale_id, "Brass banker lamp from elsewhere")

        fake = SequenceResponses([DESCRIPTION, {"matches": []}])
        install_fake(monkeypatch, fake)
        scoped = search(client, sale_id)

        fake_all = SequenceResponses([DESCRIPTION, {"matches": []}])
        install_fake(monkeypatch, fake_all)
        everywhere = search(client)

    assert scoped.status_code == 200
    assert scoped.json()["matches"] == []
    assert "elsewhere" not in texts_in(fake.calls[1])
    assert len(images_in(fake.calls[1])) == 1 + MAX_IMAGE_CANDIDATES
    assert everywhere.status_code == 200
    assert "elsewhere" in texts_in(fake_all.calls[1])
    assert len(images_in(fake_all.calls[1])) <= 1 + MAX_IMAGE_CANDIDATES


def test_search_with_no_items_or_missing_sale_skips_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(app) as client:
        empty_sale = make_sale(client, "Empty Sale")
        fake = SequenceResponses([])
        install_fake(monkeypatch, fake)
        empty = search(client, empty_sale)
        missing = search(client, 999999)
        bad_type = client.post(
            "/api/items/search-by-photo", files={"photo": ("a.txt", b"hello", "text/plain")}
        )

    assert empty.status_code == 200
    assert empty.json() == {"summary": "", "matches": [], "candidates_considered": 0}
    assert missing.status_code == 404
    assert bad_type.status_code == 400
    assert fake.calls == []


def test_search_errors_use_the_pricing_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    with TestClient(app) as client:
        sale_id = make_sale(client, "Error Sale")
        make_item(client, sale_id, "Brass lamp")

        auth_error = openai.AuthenticationError(
            "Incorrect API key provided",
            response=httpx.Response(401, request=request),
            body={"code": "invalid_api_key", "type": "invalid_request_error"},
        )
        install_fake(monkeypatch, SequenceResponses(error=auth_error))
        unauthorized = search(client, sale_id)

        install_fake(monkeypatch, SequenceResponses(error=openai.APITimeoutError(request=request)))
        timed_out = search(client, sale_id)

        quota_error = openai.RateLimitError(
            "quota",
            response=httpx.Response(429, request=request),
            body={"code": "insufficient_quota", "type": "insufficient_quota"},
        )
        install_fake(monkeypatch, SequenceResponses(error=quota_error))
        out_of_credit = search(client, sale_id)

    assert unauthorized.status_code == 503
    assert "invalid_api_key" in unauthorized.json()["detail"]
    assert timed_out.status_code == 504
    assert "too long" in timed_out.json()["detail"]
    assert out_of_credit.status_code == 503
    assert "billing" in out_of_credit.json()["detail"]
