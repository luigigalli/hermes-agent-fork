"""The dashboard renders a custody-managed checkout (update_source=external) as state, not failure.

t_536c3c97: the desktop's backend leg reads GET /api/hermes/update/check. A local-only
branch whose update source is managed externally (gitops custody) must answer behind 0,
can_apply False and the explanation — never the "Couldn't reach the update source" failure
message, which the desktop surfaces as a permanent "Hermes Update failed" warning.
"""
import contextlib
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def check_client(monkeypatch):
    from fastapi import FastAPI

    from hermes_cli import source_check
    from hermes_cli.web_routers import actions

    monkeypatch.setattr(actions, "is_commit_build", lambda *_a, **_k: False)
    monkeypatch.setattr("hermes_cli.web_server_files._dashboard_local_update_managed_externally",
                        lambda: False)
    monkeypatch.setattr("hermes_cli.config.detect_install_method", lambda *_a, **_k: "git")
    monkeypatch.setattr("hermes_cli.web_server_profiles._config_profile_scope",
                        lambda *_a, **_k: contextlib.nullcontext())
    monkeypatch.setattr(actions, "get_version_info",
                        lambda: SimpleNamespace(derived_version="0.0.0+gmanagetest"))
    app = FastAPI()
    app.include_router(actions.router)
    client = TestClient(app)

    def feed(status):
        monkeypatch.setattr(source_check, "check_for_updates", lambda **_kw: status)
        return client.get("/api/hermes/update/check")

    return feed


def test_external_update_source_answers_managed_not_failure(check_client):
    response = check_client({
        "supported": True, "behind": None, "commits": [], "localOnly": True,
        "update_source": "external", "keptLocalBranch": "convergence", "error": None,
        "message": "Updates are managed externally (gitops custody): branch 'convergence' "
                   "is gone from the remote but has commits that are not in main — "
                   "no self-update source.",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["update_source"] == "external"
    assert data["behind"] == 0
    assert data["update_available"] is False
    assert data["can_apply"] is False
    assert "managed externally" in data["message"]
    assert "Couldn't reach" not in data["message"]


def test_unreachable_check_keeps_its_failure_message(check_client):
    """A check that genuinely could not run still names the failure; the external-verdict
    branch must not swallow it."""
    response = check_client({"supported": True, "behind": None, "commits": []})
    data = response.json()
    assert data["behind"] is None
    assert "Couldn't reach the update source" in data["message"]
