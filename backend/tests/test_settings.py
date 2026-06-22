"""Settings and pricing configuration regression tests."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from backend.config import settings as settings_module
from backend.core.pricing import PricingConfigurationError, PricingEstimateService


def clear_database_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove database-related environment variables for an isolated settings test."""

    for env_name in (
        "MUFFINES_DATABASE_URL",
        "MUFFINES_DATABASE_PATH",
        "DATABASE_URL",
        "POSTGRES_URL",
        "POSTGRES_PRISMA_URL",
        "POSTGRES_URL_NON_POOLING",
        "NEON_DATABASE_URL",
    ):
        monkeypatch.delenv(env_name, raising=False)


def test_settings_accept_standard_database_url_environment_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hosted deployments should accept the common DATABASE_URL environment variable."""

    clear_database_environment(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@db.example.com:5432/muffines")
    settings_module.get_settings.cache_clear()

    settings = settings_module.get_settings()

    assert settings.database_source == "DATABASE_URL"
    assert settings.database_url == "postgresql+psycopg://user:pass@db.example.com:5432/muffines"

    settings_module.get_settings.cache_clear()


def test_pricing_configuration_message_mentions_deployment_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing pricing configuration should tell the user how to fix local and deployed setups."""

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    missing_key_path = Path(__file__).resolve().parent / "missing-openai-key.txt"
    settings = replace(settings_module.get_settings(), openai_api_key_path=missing_key_path)
    monkeypatch.setattr("backend.core.pricing.get_settings", lambda: settings)

    with pytest.raises(PricingConfigurationError) as error:
        PricingEstimateService.from_settings()

    message = str(error.value)
    assert "OPENAI_API_KEY" in message
    assert "open api.txt" in message
