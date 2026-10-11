# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Tests for the GitHub OAuth provider when it is redirected to an Authentik
(generic OIDC) identity provider via the AUTHENTIK_* environment variables.
"""

import base64
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

import pytest
from django.test import RequestFactory

from plane.authentication.provider.oauth.github import GitHubOAuthProvider
from plane.db.models import User, WorkspaceMember

AUTHENTIK_ENV = {
    "AUTHENTIK_AUTHORIZE_URL": "https://sso.example.com/application/o/authorize/",
    "AUTHENTIK_TOKEN_URL": "https://sso.example.com/application/o/token/",
    "AUTHENTIK_USERINFO_URL": "https://sso.example.com/application/o/userinfo/",
}

OIDC_USERINFO = {
    "sub": "abc123",
    "email": "oidc.user@example.com",
    "email_verified": True,
    "name": "OIDC User",
    "preferred_username": "oidc.user",
    "picture": "https://sso.example.com/avatar.png",
}


@pytest.fixture
def authentik_env(monkeypatch):
    for key, value in AUTHENTIK_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("AUTHENTIK_SCOPE", raising=False)
    monkeypatch.delenv("AUTO_JOIN_WORKSPACE_SLUG", raising=False)


def build_provider(organization_id=None, code="auth-code"):
    request = RequestFactory().get("/auth/github/callback/")
    with patch(
        "plane.authentication.provider.oauth.github.get_configuration_value",
        return_value=("client-id", "client-secret", organization_id),
    ):
        return GitHubOAuthProvider(request=request, code=code, state="state-123")


@pytest.mark.unit
class TestGitHubOIDCProvider:
    def test_auth_url_points_to_authentik_with_oidc_params(self, authentik_env):
        provider = build_provider()

        parsed = urlparse(provider.get_auth_url())
        params = parse_qs(parsed.query)

        assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == AUTHENTIK_ENV["AUTHENTIK_AUTHORIZE_URL"]
        assert params["response_type"] == ["code"]
        assert params["scope"] == ["openid email profile"]
        assert params["client_id"] == ["client-id"]
        assert params["state"] == ["state-123"]
        assert provider.get_token_url() == AUTHENTIK_ENV["AUTHENTIK_TOKEN_URL"]
        assert provider.get_user_info_url() == AUTHENTIK_ENV["AUTHENTIK_USERINFO_URL"]

    def test_falls_back_to_github_without_authentik_env(self, monkeypatch):
        for key in AUTHENTIK_ENV:
            monkeypatch.delenv(key, raising=False)

        provider = build_provider(organization_id="my-org")

        assert provider.get_auth_url().startswith("https://github.com/login/oauth/authorize?")
        assert provider.scope == "read:user user:email read:org"
        assert provider.get_token_url() == "https://github.com/login/oauth/access_token"

    def test_token_exchange_sends_basic_auth_and_grant_type(self, authentik_env):
        provider = build_provider()

        with patch.object(provider, "get_user_token", return_value={"access_token": "tok"}) as mock_token:
            provider.set_token_data()

        kwargs = mock_token.call_args.kwargs
        expected = base64.b64encode(b"client-id:client-secret").decode()
        assert kwargs["headers"]["Authorization"] == f"Basic {expected}"
        assert kwargs["data"]["grant_type"] == "authorization_code"
        assert kwargs["data"]["code"] == "auth-code"
        assert provider.token_data["access_token"] == "tok"

    def test_user_data_uses_oidc_claims_and_skips_github_org_check(self, authentik_env):
        provider = build_provider(organization_id="my-org")
        provider.token_data = {"access_token": "tok"}

        with (
            patch.object(provider, "get_user_response", return_value=OIDC_USERINFO),
            patch.object(provider, "is_user_in_organization") as mock_org_check,
            patch("plane.authentication.provider.oauth.github.requests.get") as mock_get,
        ):
            provider.set_user_data()

        mock_org_check.assert_not_called()
        mock_get.assert_not_called()  # email comes from userinfo, not GitHub's emails API
        assert provider.user_data["email"] == "oidc.user@example.com"
        assert provider.user_data["user"] == {
            "provider_id": "abc123",
            "email": "oidc.user@example.com",
            "avatar": "https://sso.example.com/avatar.png",
            "display_name": "oidc.user",
            "first_name": "OIDC User",
            "last_name": "",
            "is_password_autoset": True,
        }


@pytest.mark.unit
@pytest.mark.django_db
class TestGitHubOIDCAutoJoin:
    def test_auto_joins_configured_workspace_as_member(self, authentik_env, monkeypatch, workspace):
        monkeypatch.setenv("AUTO_JOIN_WORKSPACE_SLUG", workspace.slug)
        provider = build_provider()
        user = User.objects.create(email="oidc.user@example.com", username="oidc_user")

        provider._auto_join_workspace(user)
        provider._auto_join_workspace(user)  # idempotent

        memberships = WorkspaceMember.objects.filter(workspace=workspace, member=user)
        assert memberships.count() == 1
        assert memberships.first().role == 15

    def test_missing_workspace_does_not_break_login(self, authentik_env, monkeypatch, create_user):
        monkeypatch.setenv("AUTO_JOIN_WORKSPACE_SLUG", "does-not-exist")
        provider = build_provider()

        provider._auto_join_workspace(create_user)

        assert not WorkspaceMember.objects.filter(member=create_user).exists()

    def test_authenticate_runs_auto_join(self, authentik_env, create_user):
        provider = build_provider()

        with (
            patch("plane.authentication.adapter.oauth.OauthAdapter.authenticate", return_value=create_user),
            patch.object(provider, "_auto_join_workspace") as mock_join,
        ):
            assert provider.authenticate() == create_user

        mock_join.assert_called_once_with(create_user)
