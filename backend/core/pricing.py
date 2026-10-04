"""AI-assisted pricing helpers."""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass

import openai
from openai import OpenAI

from backend.config.settings import get_logger, get_settings
from backend.core.schemas import PricingEstimateResponse

LOGGER = get_logger(__name__)

CONDITION_OPTIONS = ("New", "Like New", "Excellent", "Good", "Fair", "Poor", "For Parts")

# Keep the OpenAI call well inside the serverless function time limit.
OPENAI_TIMEOUT_SECONDS = 45.0

PRICING_JSON_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "suggested_title": {"type": "string"},
        "suggested_description": {"type": "string"},
        "suggested_category": {"type": "string"},
        "suggested_room": {"type": "string"},
        "suggested_condition": {"type": "string", "enum": [*CONDITION_OPTIONS, ""]},
        "estimated_price": {"type": ["number", "null"]},
        "low_estimate": {"type": ["number", "null"]},
        "high_estimate": {"type": ["number", "null"]},
        "reasoning": {"type": "string"},
        "follow_up_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "suggested_title",
        "suggested_description",
        "suggested_category",
        "suggested_room",
        "suggested_condition",
        "estimated_price",
        "low_estimate",
        "high_estimate",
        "reasoning",
        "follow_up_questions",
    ],
}


class PricingConfigurationError(RuntimeError):
    """Raised when AI pricing cannot be configured."""


class PricingServiceError(RuntimeError):
    """Raised when the AI provider rejects or fails a pricing request."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def clean_api_key(raw_value: str) -> str:
    """Strip whitespace, a BOM, surrounding quotes, and an `OPENAI_API_KEY=` prefix."""

    value = raw_value.replace("﻿", "").strip()
    if value.upper().startswith("OPENAI_API_KEY="):
        value = value.split("=", 1)[1].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1].strip()
    return value


@dataclass
class PricingEstimateService:
    """Generate estate-sale price estimates from item photos."""

    client: OpenAI
    model: str

    @classmethod
    def from_settings(cls) -> "PricingEstimateService":
        """Build a pricing service using the configured API key source."""

        settings = get_settings()
        api_key = clean_api_key(os.getenv("OPENAI_API_KEY", ""))
        if not api_key and settings.openai_api_key_path.exists():
            api_key = clean_api_key(settings.openai_api_key_path.read_text(encoding="utf-8"))

        if not api_key:
            raise PricingConfigurationError(
                'AI pricing is not configured yet. Set OPENAI_API_KEY for hosted deployments or add an OpenAI key to "open api.txt" for local runs.'
            )

        client = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS, max_retries=1)
        return cls(client=client, model=settings.pricing_model)

    def estimate_from_image(
        self,
        *,
        image_bytes: bytes,
        media_type: str,
        category_hint: str,
        room_hint: str,
        notes: str,
        follow_up_answers: str,
        categories: list[str] | None = None,
    ) -> PricingEstimateResponse:
        """Return a structured pricing estimate for the supplied image."""

        sale_categories = [name.strip() for name in categories or [] if name.strip()]
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        if sale_categories:
            category_rule = (
                "suggested_category must be exactly one of these sale categories, or an empty string if none fit: "
                + json.dumps(sale_categories)
            )
        else:
            category_rule = "suggested_category should be a short general category such as Furniture or Kitchen."

        context_lines = [
            "You are helping price an item for an estate sale.",
            "Estimate a realistic estate-sale asking price in USD, not retail replacement value.",
            "suggested_title is a short item name for the sale tag (under 80 characters).",
            "suggested_description is one or two plain sentences describing the item (material, maker, size, notable details).",
            category_rule,
            "suggested_room is the room of a house the item most likely came from, such as Kitchen or Living Room.",
            f"suggested_condition must be one of {json.dumps(list(CONDITION_OPTIONS))}, or an empty string if you cannot tell.",
            "If the image is unclear or key details are missing, ask up to three concise follow-up questions.",
            f"Current category hint: {category_hint or 'None'}",
            f"Current room hint: {room_hint or 'None'}",
            f"Current notes: {notes or 'None'}",
            f"Follow-up answers: {follow_up_answers or 'None'}",
        ]

        try:
            response = self.client.responses.create(
                model=self.model,
                input=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "input_text",
                                "text": "\n".join(context_lines),
                            },
                            {
                                "type": "input_image",
                                "image_url": f"data:{media_type};base64,{image_b64}",
                            },
                        ],
                    }
                ],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "estate_sale_item_estimate",
                        "schema": PRICING_JSON_SCHEMA,
                        "strict": True,
                    }
                },
            )
        except openai.AuthenticationError as error:
            LOGGER.error("OpenAI rejected the API key: %s", _error_code(error))
            raise PricingServiceError(
                "OpenAI rejected the API key (401 invalid_api_key). Create a new key at platform.openai.com/api-keys and update OPENAI_API_KEY.",
                status_code=503,
            ) from error
        except openai.PermissionDeniedError as error:
            LOGGER.error("OpenAI permission denied: %s", _error_code(error))
            raise PricingServiceError(
                f"The OpenAI key does not have access to model {self.model} (403).",
                status_code=503,
            ) from error
        except openai.RateLimitError as error:
            code = _error_code(error)
            LOGGER.error("OpenAI rate limit or quota error: %s", code)
            if code == "insufficient_quota":
                message = "The OpenAI account is out of credit (429 insufficient_quota). Add billing at platform.openai.com."
            else:
                message = "OpenAI is rate limiting requests right now (429). Try again in a minute."
            raise PricingServiceError(message, status_code=503) from error
        except openai.NotFoundError as error:
            LOGGER.error("OpenAI model not found: %s", self.model)
            raise PricingServiceError(
                f"OpenAI model {self.model} is not available (404). Set MUFFINES_PRICING_MODEL to a current vision model.",
                status_code=502,
            ) from error
        except openai.APITimeoutError as error:
            LOGGER.error("OpenAI request timed out")
            raise PricingServiceError("The AI took too long to respond. Try again.", status_code=504) from error
        except openai.APIConnectionError as error:
            LOGGER.error("Could not reach OpenAI: %s", error)
            raise PricingServiceError("Could not reach OpenAI. Try again.", status_code=502) from error
        except openai.APIStatusError as error:
            LOGGER.error("OpenAI request failed: %s %s", error.status_code, _error_code(error))
            raise PricingServiceError(
                f"OpenAI request failed ({error.status_code} {_error_code(error) or 'error'}).",
                status_code=502,
            ) from error

        raw_text = response.output_text.strip()
        payload = self._extract_json_payload(raw_text)

        follow_up_questions = payload.get("follow_up_questions", [])
        if not isinstance(follow_up_questions, list):
            follow_up_questions = []

        return PricingEstimateResponse(
            suggested_title=str(payload.get("suggested_title") or "").strip(),
            suggested_description=str(payload.get("suggested_description") or "").strip(),
            suggested_category=self._match_category(
                str(payload.get("suggested_category") or "").strip(), sale_categories
            ),
            suggested_room=str(payload.get("suggested_room") or "").strip(),
            suggested_condition=self._match_condition(str(payload.get("suggested_condition") or "").strip()),
            estimated_price=self._coerce_number(payload.get("estimated_price")),
            low_estimate=self._coerce_number(payload.get("low_estimate")),
            high_estimate=self._coerce_number(payload.get("high_estimate")),
            reasoning=str(payload.get("reasoning") or "").strip(),
            follow_up_questions=[
                str(question).strip()
                for question in follow_up_questions
                if str(question).strip()
            ],
        )

    @staticmethod
    def _match_category(suggested: str, sale_categories: list[str]) -> str:
        """Map a suggested category onto the sale's categories, or blank if none fit."""

        if not sale_categories:
            return suggested
        lookup = {name.casefold(): name for name in sale_categories}
        return lookup.get(suggested.casefold(), "")

    @staticmethod
    def _match_condition(suggested: str) -> str:
        """Normalize the condition to one of the known options."""

        lookup = {option.casefold(): option for option in CONDITION_OPTIONS}
        return lookup.get(suggested.casefold(), "")

    def _extract_json_payload(self, raw_text: str) -> dict[str, object]:
        """Extract a JSON object from a model response."""

        start_index = raw_text.find("{")
        end_index = raw_text.rfind("}")
        if start_index == -1 or end_index == -1 or end_index <= start_index:
            raise ValueError("The pricing model did not return valid JSON.")

        json_text = raw_text[start_index : end_index + 1]
        try:
            payload = json.loads(json_text)
        except json.JSONDecodeError as error:
            LOGGER.error("Failed to decode pricing JSON: %s", raw_text)
            raise ValueError("The pricing model returned malformed JSON.") from error

        if not isinstance(payload, dict):
            raise ValueError("The pricing model returned an unexpected payload shape.")
        return payload

    @staticmethod
    def _coerce_number(value: object) -> float | None:
        """Convert numeric-ish model output into a float."""

        if value in (None, ""):
            return None

        try:
            return round(float(value), 2)
        except (TypeError, ValueError):
            return None


def _error_code(error: openai.APIStatusError) -> str:
    """Return the OpenAI error code without echoing the message (which can include a masked key)."""

    body = error.body
    if isinstance(body, dict):
        nested = body.get("error") if isinstance(body.get("error"), dict) else body
        return str(nested.get("code") or nested.get("type") or "")
    return ""
