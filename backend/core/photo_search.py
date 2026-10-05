"""Find saved inventory items that match a photo, using two bounded OpenAI vision calls.

Pipeline (at most two OpenAI calls and 1 + MAX_IMAGE_CANDIDATES images per search):

1. `describe_photo` asks the model what the query photo shows (object type,
   materials, colours, distinguishing features, keywords).
2. `select_candidates` ranks the inventory by word overlap between that
   description and each item's text, keeping the best items that have a stored
   photo (sent as low-detail images) plus a few text-only items.
3. `PhotoItemMatcher.match` shows the model the query photo and the candidates
   (labelled C1..Cn) and asks which candidates appear in the photo. Only labels
   from the candidate set are accepted, so the model can never return an item
   outside it.

The matcher returns every candidate that appears in the photo, so the same
function can later identify several items in one picture (e.g. at checkout).
"""

from __future__ import annotations

import base64
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from backend.core.pricing import PricingEstimateService

# Bounds per search: images sent, text-only candidates, and per-call time.
MAX_IMAGE_CANDIDATES = 8
MAX_TEXT_ONLY_CANDIDATES = 4
SEARCH_CALL_TIMEOUT_SECONDS = 25.0
CONFIDENCE_LEVELS = ("high", "medium", "low")

STOP_WORDS = frozenset(
    "a an and are as at be by for from has have in is it its of on or the this to with without "
    "item items object photo picture image shows showing appears visible small large".split()
)

DESCRIPTION_JSON_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "object_type": {"type": "string"},
        "summary": {"type": "string"},
        "materials": {"type": "array", "items": {"type": "string"}},
        "colors": {"type": "array", "items": {"type": "string"}},
        "distinguishing_features": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["object_type", "summary", "materials", "colors", "distinguishing_features", "keywords"],
}

MATCH_JSON_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "matches": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "candidate": {"type": "string"},
                    "confidence": {"type": "string", "enum": list(CONFIDENCE_LEVELS)},
                    "reason": {"type": "string"},
                },
                "required": ["candidate", "confidence", "reason"],
            },
        }
    },
    "required": ["matches"],
}


@dataclass
class SearchableItem:
    """The text of one inventory item, plus whether it has a stored photo."""

    id: int
    title: str
    description: str = ""
    category: str = ""
    room: str = ""
    condition: str = ""
    notes: str = ""
    has_photo: bool = False

    def search_text(self) -> str:
        return " ".join([self.title, self.description, self.category, self.room, self.condition, self.notes])


@dataclass
class PhotoDescription:
    """What the model saw in the query photo."""

    object_type: str = ""
    summary: str = ""
    materials: list[str] = field(default_factory=list)
    colors: list[str] = field(default_factory=list)
    distinguishing_features: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)

    def search_text(self) -> str:
        parts = [self.object_type, self.summary, *self.materials, *self.colors, *self.distinguishing_features]
        return " ".join(parts + self.keywords)


@dataclass
class PhotoMatch:
    """One inventory item the model found in the photo."""

    item_id: int
    confidence: str
    reason: str


@dataclass
class PhotoSearchResult:
    description: PhotoDescription
    matches: list[PhotoMatch]
    candidate_count: int


def tokenize(text: str) -> set[str]:
    """Lower-case words (with a crude plural strip) used for text overlap."""

    words = set()
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        if len(word) < 3 or word in STOP_WORDS:
            continue
        if len(word) > 4 and word.endswith("es") and not word.endswith("ses"):
            word = word[:-2]
        elif len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        words.add(word)
    return words


def score_item(query_words: set[str], keyword_words: set[str], item: SearchableItem) -> float:
    """Overlap score; title hits and the model's keywords/object type count more."""

    title_words = tokenize(item.title)
    other_words = tokenize(item.search_text())
    score = 0.0
    for word in query_words:
        weight = 2.0 if word in keyword_words else 1.0
        if word in title_words:
            score += 2.0 * weight
        elif word in other_words:
            score += weight
    return score


def select_candidates(description: PhotoDescription, items: Sequence[SearchableItem]) -> list[SearchableItem]:
    """Pick the items worth showing the model: the best photo items plus a few text-only ones.

    Items with no word overlap only fill the image slots (newest first, as the
    caller orders them), since a photo can still match when the words differ.
    """

    query_words = tokenize(description.search_text())
    keyword_words = tokenize(" ".join([description.object_type, *description.keywords]))
    scored = [(score_item(query_words, keyword_words, item), position, item) for position, item in enumerate(items)]
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    with_photo = [item for _, _, item in scored if item.has_photo][:MAX_IMAGE_CANDIDATES]
    text_only = [item for score, _, item in scored if not item.has_photo and score > 0][:MAX_TEXT_ONLY_CANDIDATES]
    return with_photo + text_only


def _clean_strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(entry).strip() for entry in value if str(entry).strip()]


class PhotoItemMatcher:
    """Match a photo against inventory items using the shared OpenAI service."""

    def __init__(self, service: PricingEstimateService) -> None:
        self.service = service

    def _call(self, content: list[dict[str, object]], name: str, schema: dict[str, object]) -> dict[str, object]:
        # No retries and a short timeout: two calls must fit well inside the serverless limit.
        return self.service.create_structured(
            content=content,
            schema_name=name,
            schema=schema,
            timeout=SEARCH_CALL_TIMEOUT_SECONDS,
            max_retries=0,
        )

    def describe_photo(self, image_bytes: bytes, media_type: str) -> PhotoDescription:
        """Stage 1: describe what the photo shows, in words useful for text search."""

        payload = self._call(
            [
                {
                    "type": "input_text",
                    "text": (
                        "Describe the main item(s) in this photo so they can be found in an estate-sale "
                        "inventory. object_type is a short noun phrase (e.g. 'table lamp'). summary is one "
                        "sentence. List materials, colours, distinguishing features (maker marks, patterns, "
                        "shape, visible text) and 5-12 search keywords including common synonyms."
                    ),
                },
                {"type": "input_image", "image_url": _data_url(image_bytes, media_type)},
            ],
            "photo_item_description",
            DESCRIPTION_JSON_SCHEMA,
        )
        return PhotoDescription(
            object_type=str(payload.get("object_type") or "").strip(),
            summary=str(payload.get("summary") or "").strip(),
            materials=_clean_strings(payload.get("materials")),
            colors=_clean_strings(payload.get("colors")),
            distinguishing_features=_clean_strings(payload.get("distinguishing_features")),
            keywords=_clean_strings(payload.get("keywords")),
        )

    def match(
        self,
        *,
        image_bytes: bytes,
        media_type: str,
        items: Sequence[SearchableItem],
        load_photos: Callable[[list[int]], dict[int, tuple[bytes, str]]],
    ) -> PhotoSearchResult:
        """Find which of `items` appear in the photo (several may match).

        `load_photos` returns {item_id: (bytes, content_type)} for the given ids;
        it is only called for the few chosen candidates.
        """

        description = self.describe_photo(image_bytes, media_type)
        candidates = select_candidates(description, items)
        if not candidates:
            return PhotoSearchResult(description=description, matches=[], candidate_count=0)

        photos = load_photos([item.id for item in candidates if item.has_photo])
        labels: dict[str, SearchableItem] = {}
        content: list[dict[str, object]] = [
            {
                "type": "input_text",
                "text": (
                    "The first image is a photo taken by an estate-sale worker. After it come candidate "
                    "items from the sale inventory, each labelled C1, C2, ... with its saved details and, "
                    "when available, its saved photo. Decide which candidates are the same physical item "
                    "(or the same product) as one shown in the first photo. More than one candidate may "
                    "match if the photo shows several items. Only use labels from the list. Use 'high' "
                    "only when the saved photo clearly shows the same item; 'low' for a plausible text-only "
                    "match. Return an empty list when nothing matches."
                ),
            },
            {"type": "input_image", "image_url": _data_url(image_bytes, media_type)},
        ]
        for position, item in enumerate(candidates, start=1):
            label = f"C{position}"
            labels[label] = item
            details = "; ".join(
                part
                for part in [
                    f"{label}: {item.title}",
                    item.description,
                    f"category {item.category}" if item.category else "",
                    f"room {item.room}" if item.room else "",
                    f"condition {item.condition}" if item.condition else "",
                    item.notes,
                ]
                if part
            )
            photo = photos.get(item.id)
            content.append({"type": "input_text", "text": details + ("" if photo else " (no saved photo)")})
            if photo:
                content.append({"type": "input_image", "image_url": _data_url(*photo), "detail": "low"})

        payload = self._call(content, "photo_item_matches", MATCH_JSON_SCHEMA)
        raw_matches = payload.get("matches")
        matches: list[PhotoMatch] = []
        seen: set[int] = set()
        for entry in raw_matches if isinstance(raw_matches, list) else []:
            if not isinstance(entry, dict):
                continue
            item = labels.get(str(entry.get("candidate") or "").strip().upper())
            confidence = str(entry.get("confidence") or "").strip().lower()
            if item is None or item.id in seen or confidence not in CONFIDENCE_LEVELS:
                continue
            seen.add(item.id)
            matches.append(PhotoMatch(item_id=item.id, confidence=confidence, reason=str(entry.get("reason") or "").strip()))
        matches.sort(key=lambda match: CONFIDENCE_LEVELS.index(match.confidence))
        return PhotoSearchResult(description=description, matches=matches, candidate_count=len(candidates))


def _data_url(image_bytes: bytes, media_type: str) -> str:
    return f"data:{media_type};base64,{base64.b64encode(image_bytes).decode('utf-8')}"
