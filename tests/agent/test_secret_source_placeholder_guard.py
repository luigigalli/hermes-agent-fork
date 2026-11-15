"""The D38 placeholder guard on secret-source hydration (kanban t_80e4e706).

A secret source that answers a placeholder/masked value ("***", "****", or an
empty mask) must never land that value anywhere: not in ``.env``, not in the
runtime environment. The apply path skips the var loudly — the report names the
skipped values via ``skipped_placeholder`` and a WARNING names the source.

Contract under test:

* placeholder ``***`` → skip, reported, env untouched;
* empty/whitespace mask → skip, reported, env untouched;
* a real value on a healthy source → applies normally (claimed + provenance).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent.secret_sources.base import FetchResult, SecretSource  # noqa: E402
from agent.secret_sources.registry import (  # noqa: E402
    ApplyReport,
    SourceReport,
    _Applier,
)


class _StubSource(SecretSource):
    """The minimal source surface `_try_apply` reads: its name."""

    name = "stub-source"

    def fetch(self, cfg: dict, home_path: Path) -> FetchResult:
        raise AssertionError("fetch must not run in guard tests")

    def fetch_timeout_seconds(self, cfg: dict) -> float:
        return 1.0


def _applier(env: dict) -> _Applier:
    return _Applier(env, ApplyReport(), protected={}, preserve=frozenset())


def test_placeholder_mask_is_skipped_and_reported_never_environ() -> None:
    env: dict[str, str] = {}
    applier = _applier(env)
    sr = SourceReport(name="stub-source", label="stub-source", result=FetchResult())
    source = _StubSource()

    ok = applier._try_apply(sr, source, override=True, var="OMNIROUTE_API_KEY", value="***")

    assert ok is False
    assert "OMNIROUTE_API_KEY" not in env
    assert sr.applied == []
    assert sr.skipped_placeholder == ["***"]


def test_empty_and_whitespace_masks_are_skipped_too() -> None:
    env: dict[str, str] = {}
    applier = _applier(env)
    sr = SourceReport(name="stub-source", label="stub-source", result=FetchResult())
    source = _StubSource()

    for masked in ("", "   ", "****"):
        ok = applier._try_apply(sr, source, override=True, var="OLLAMA_API_KEY", value=masked)

        assert ok is False
        assert "OLLAMA_API_KEY" not in env

    assert sr.applied == []
    assert set(sr.skipped_placeholder) == {"", "   ", "****"}


def test_real_value_from_a_healthy_source_still_applies() -> None:
    env: dict[str, str] = {}
    applier = _applier(env)
    sr = SourceReport(name="stub-source", label="stub-source", result=FetchResult())
    source = _StubSource()

    ok = applier._try_apply(sr, source, override=True, var="OLLAMA_API_KEY", value="real-value")

    assert ok is True
    assert env["OLLAMA_API_KEY"] == "real-value"
    assert sr.applied == ["OLLAMA_API_KEY"]
    assert sr.skipped_placeholder == []
    assert applier.claimed["OLLAMA_API_KEY"] == "stub-source"
    assert "OLLAMA_API_KEY" in applier.report.provenance
