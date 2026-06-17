"""AI-assisted pricing helpers."""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass

from openai import OpenAI

from backend.config.settings import get_logger, get_settings
from backend.core.schemas import PricingEstimateResponse

LOGGER = get_logger(__name__)


class PricingConfigurationError(RuntimeError):
    """Raised when AI pricing cannot be configured."""


@dataclass
class PricingEstimateService:
    """Generate estate-sale price estimates from item photos."""

    client: OpenAI
    model: str

    @classmethod
    def from_settings(cls) -> "PricingEstimateService":
        """Build a pricing service using the configured API key source."""

        settings = get_settings()
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key and settings.openai_api_key_path.exists():
            api_key = settings.openai_api_key_path.read_text(encoding="utf-8").strip()

        if not api_key:
            raise PricingConfigurationError(
                'AI pricing is not configured yet. Add an OpenAI key to "open api.txt".'
            )

        return cls(client=OpenAI(api_key=api_key), model=settings.pricing_model)

    def estimate_from_image(
        self,
        *,
        image_bytes: bytes,
        media_type: str,
        category_hint: str,
        room_hint: str,
        notes: str,
        follow_up_answers: str,
    ) -> PricingEstimateResponse:
        """Return a structured pricing estimate for the supplied image."""

        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        context_lines = [
            "You are helping price an item for an estate sale.",
            "Return only strict JSON.",
            "Estimate a realistic estate-sale asking price in USD, not retail replacement value.",
            "If the image is unclear or key details are missing, ask up to three concise follow-up questions.",
            'Use this JSON shape: {"suggested_title":"","suggested_category":"","suggested_room":"","estimated_price":0,"low_estimate":0,"high_estimate":0,"reasoning":"","follow_up_questions":[""]}',
            f"Current category hint: {category_hint or 'None'}",
            f"Current room hint: {room_hint or 'None'}",
            f"Current notes: {notes or 'None'}",
            f"Follow-up answers: {follow_up_answers or 'None'}",
        ]

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
        )

        raw_text = response.output_text.strip()
        payload = self._extract_json_payload(raw_text)

        follow_up_questions = payload.get("follow_up_questions", [])
        if not isinstance(follow_up_questions, list):
            follow_up_questions = []

        return PricingEstimateResponse(
            suggested_title=str(payload.get("suggested_title", "")).strip(),
            suggested_category=str(payload.get("suggested_category", "")).strip(),
            suggested_room=str(payload.get("suggested_room", "")).strip(),
            estimated_price=self._coerce_number(payload.get("estimated_price")),
            low_estimate=self._coerce_number(payload.get("low_estimate")),
            high_estimate=self._coerce_number(payload.get("high_estimate")),
            reasoning=str(payload.get("reasoning", "")).strip(),
            follow_up_questions=[
                str(question).strip()
                for question in follow_up_questions
                if str(question).strip()
            ],
        )

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
