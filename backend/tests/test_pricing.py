"""Tests for the AI pricing endpoint with the OpenAI call mocked out."""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

TEST_DATABASE_PATH = Path(__file__).resolve().parents[2] / "data" / "test-pricing.db"
TEST_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MUFFINES_DATABASE_PATH", str(TEST_DATABASE_PATH))

from backend.core import pricing
from backend.core.pricing import PricingEstimateService, clean_api_key
from backend.main import app

PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c63f8cfc0f00f0004850180848a8c21"
    "0000000049454e44ae426082"
)


class FakeResponses:
    """Stand-in for `client.responses` that records the request."""

    def __init__(self, payload: dict[str, object] | None = None, error: Exception | None = None) -> None:
        self.payload = payload
        self.error = error
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs: object) -> SimpleNamespace:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(output_text=json.dumps(self.payload))


def install_fake(monkeypatch: pytest.MonkeyPatch, fake: FakeResponses) -> None:
    """Make the endpoint use a pricing service backed by the fake client."""

    service = PricingEstimateService(client=SimpleNamespace(responses=fake), model="test-model")
    monkeypatch.setattr(pricing.PricingEstimateService, "from_settings", classmethod(lambda cls: service))


def post_estimate(client: TestClient, **form: str) -> httpx.Response:
    return client.post(
        "/api/pricing/estimate",
        files={"photo": ("item.png", PNG_BYTES, "image/png")},
        data=form,
    )


FULL_PAYLOAD: dict[str, object] = {
    "suggested_title": "Mid-century walnut side table",
    "suggested_description": "Solid walnut side table with tapered legs.",
    "suggested_category": "furniture",
    "suggested_room": "Living Room",
    "suggested_condition": "excellent",
    "estimated_price": 85,
    "low_estimate": 60,
    "high_estimate": 110.456,
    "reasoning": "Comparable tables sell for $60-$110.",
    "follow_up_questions": ["Any maker's mark?", " "],
}


def test_estimate_returns_all_form_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """The endpoint should return every suggested form field, mapped onto the sale categories."""

    fake = FakeResponses(payload=FULL_PAYLOAD)
    install_fake(monkeypatch, fake)

    with TestClient(app) as client:
        response = post_estimate(client, categories=json.dumps(["Furniture", "Kitchen"]))

    assert response.status_code == 200
    body = response.json()
    assert body["suggested_title"] == "Mid-century walnut side table"
    assert body["suggested_description"] == "Solid walnut side table with tapered legs."
    assert body["suggested_category"] == "Furniture"
    assert body["suggested_room"] == "Living Room"
    assert body["suggested_condition"] == "Excellent"
    assert body["estimated_price"] == 85
    assert body["high_estimate"] == 110.46
    assert body["follow_up_questions"] == ["Any maker's mark?"]

    request = fake.calls[0]
    assert request["text"]["format"]["type"] == "json_schema"
    assert request["text"]["format"]["strict"] is True
    prompt_text = request["input"][0]["content"][0]["text"]
    assert '["Furniture", "Kitchen"]' in prompt_text


def test_estimate_blanks_category_that_is_not_in_the_sale(monkeypatch: pytest.MonkeyPatch) -> None:
    """A category outside the sale's list should come back blank."""

    install_fake(monkeypatch, FakeResponses(payload={**FULL_PAYLOAD, "suggested_category": "Electronics"}))

    with TestClient(app) as client:
        response = post_estimate(client, categories="Furniture,Kitchen")

    assert response.status_code == 200
    assert response.json()["suggested_category"] == ""


def test_estimate_without_categories_keeps_free_category(monkeypatch: pytest.MonkeyPatch) -> None:
    """Older clients that send no categories still get the model's category back."""

    install_fake(monkeypatch, FakeResponses(payload={**FULL_PAYLOAD, "suggested_condition": "Mint-ish"}))

    with TestClient(app) as client:
        response = post_estimate(client)

    assert response.status_code == 200
    assert response.json()["suggested_category"] == "furniture"
    assert response.json()["suggested_condition"] == ""


def test_invalid_api_key_surfaces_clear_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 401 from OpenAI should become a clear 503, not a generic 500."""

    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    error = openai.AuthenticationError(
        "Incorrect API key provided",
        response=httpx.Response(401, request=request),
        body={"code": "invalid_api_key", "type": "invalid_request_error"},
    )
    install_fake(monkeypatch, FakeResponses(error=error))

    with TestClient(app) as client:
        response = post_estimate(client)

    assert response.status_code == 503
    assert "invalid_api_key" in response.json()["detail"]


def test_quota_error_surfaces_billing_message(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 429 insufficient_quota should tell the owner to add billing."""

    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    error = openai.RateLimitError(
        "quota",
        response=httpx.Response(429, request=request),
        body={"code": "insufficient_quota", "type": "insufficient_quota"},
    )
    install_fake(monkeypatch, FakeResponses(error=error))

    with TestClient(app) as client:
        response = post_estimate(client)

    assert response.status_code == 503
    assert "billing" in response.json()["detail"]


def test_clean_api_key_strips_common_file_noise() -> None:
    """Keys pasted with a BOM, quotes, newline, or env-style prefix should still load."""

    assert clean_api_key('﻿"sk-test-123"\r\n') == "sk-test-123"
    assert clean_api_key("OPENAI_API_KEY=sk-test-123\n") == "sk-test-123"
    assert clean_api_key("  ") == ""
