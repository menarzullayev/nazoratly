"""Fixtures reused from the per-feature suites (fake Telegram bot, fake AI transport) so the journeys share one definition."""

from tests.test_ai_reports import fake_ai
from tests.test_guardian import tg

__all__ = ["fake_ai", "tg"]
