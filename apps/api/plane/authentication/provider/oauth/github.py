# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import os
from datetime import datetime
from urllib.parse import urlencode

import pytz
import requests

from plane.authentication.adapter.error import (
    AUTHENTICATION_ERROR_CODES,
    AuthenticationException,
)

# Module imports
from plane.authentication.adapter.oauth import OauthAdapter
from plane.license.utils.instance_value import get_configuration_value


class GitHubOAuthProvider(OauthAdapter):
    org_membership_url = "https://api.github.com/orgs"

    provider = "github"

    def __init__(self, request, code=None, state=None, callback=None):
        GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_ORGANIZATION_ID = get_configuration_value([
            {
                "key": "GITHUB_CLIENT_ID",
                "default": os.environ.get("GITHUB_CLIENT_ID"),
            },
            {
                "key": "GITHUB_CLIENT_SECRET",
                "default": os.environ.get("GITHUB_CLIENT_SECRET"),
            },
            {
                "key": "GITHUB_ORGANIZATION_ID",
                "default": os.environ.get("GITHUB_ORGANIZATION_ID"),
            },
        ])

        if not (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET):
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["GITHUB_NOT_CONFIGURED"],
                error_message="GITHUB_NOT_CONFIGURED",
            )

        client_id = GITHUB_CLIENT_ID
        client_secret = GITHUB_CLIENT_SECRET
        self.organization_id = GITHUB_ORGANIZATION_ID

        # URL overrides for Authentik (or any OIDC provider); fall back to GitHub defaults.
        token_url = os.environ.get("AUTHENTIK_TOKEN_URL", "https://github.com/login/oauth/access_token")
        userinfo_url = os.environ.get("AUTHENTIK_USERINFO_URL", "https://api.github.com/user")
        authorize_base = os.environ.get("AUTHENTIK_AUTHORIZE_URL", "https://github.com/login/oauth/authorize")

        # Use OIDC scopes when redirecting to an external IdP; otherwise GitHub scopes.
        if os.environ.get("AUTHENTIK_AUTHORIZE_URL"):
            scope = os.environ.get("AUTHENTIK_SCOPE", "openid email profile")
        else:
            scope = "read:user user:email"
            if self.organization_id:
                scope += " read:org"
        self.scope = scope

        redirect_uri = f"""{"https" if request.is_secure() else "http"}://{request.get_host()}/auth/github/callback/"""
        url_params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": self.scope,
            "state": state,
        }
        auth_url = f"{authorize_base}?{urlencode(url_params)}"
        super().__init__(
            request,
            self.provider,
            client_id,
            self.scope,
            redirect_uri,
            auth_url,
            token_url,
            userinfo_url,
            client_secret,
            code,
            callback=callback,
        )

    def set_token_data(self):
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": self.code,
            "redirect_uri": self.redirect_uri,
        }
        token_response = self.get_user_token(data=data, headers={"Accept": "application/json"})
        super().set_token_data({
            "access_token": token_response.get("access_token"),
            "refresh_token": token_response.get("refresh_token", None),
            "access_token_expired_at": (
                datetime.fromtimestamp(token_response.get("expires_in"), tz=pytz.utc)
                if token_response.get("expires_in")
                else None
            ),
            "refresh_token_expired_at": (
                datetime.fromtimestamp(token_response.get("refresh_token_expired_at"), tz=pytz.utc)
                if token_response.get("refresh_token_expired_at")
                else None
            ),
            "id_token": token_response.get("id_token", ""),
        })

    def __get_email(self, headers, user_info_response):
        # Standard OIDC (Authentik) provides email directly in the userinfo response.
        if user_info_response.get("email"):
            return user_info_response["email"]
        # Fall back to the GitHub-specific separate emails endpoint.
        try:
            emails_url = "https://api.github.com/user/emails"
            emails_response = requests.get(emails_url, headers=headers).json()
            if not isinstance(emails_response, list):
                self.logger.error("Unexpected response format from GitHub emails API")
                raise AuthenticationException(
                    error_code=AUTHENTICATION_ERROR_CODES["GITHUB_OAUTH_PROVIDER_ERROR"],
                    error_message="GITHUB_OAUTH_PROVIDER_ERROR",
                )
            email = next((email["email"] for email in emails_response if email["primary"]), None)
            if not email:
                self.logger.error("No primary email found for user")
                raise AuthenticationException(
                    error_code=AUTHENTICATION_ERROR_CODES["GITHUB_OAUTH_PROVIDER_ERROR"],
                    error_message="GITHUB_OAUTH_PROVIDER_ERROR",
                )
            return email
        except requests.RequestException:
            self.logger.warning("Error getting email from GitHub")
            raise AuthenticationException(
                error_code=AUTHENTICATION_ERROR_CODES["GITHUB_OAUTH_PROVIDER_ERROR"],
                error_message="GITHUB_OAUTH_PROVIDER_ERROR",
            )

    def is_user_in_organization(self, github_username):
        headers = {"Authorization": f"Bearer {self.token_data.get('access_token')}"}
        response = requests.get(
            f"{self.org_membership_url}/{self.organization_id}/memberships/{github_username}",
            headers=headers,
        )
        return response.status_code == 200  # 200 means the user is a member

    def set_user_data(self):
        user_info_response = self.get_user_response()
        headers = {
            "Authorization": f"Bearer {self.token_data.get('access_token')}",
            "Accept": "application/json",
        }

        if self.organization_id:
            if not self.is_user_in_organization(user_info_response.get("login")):
                self.logger.warning(
                    "User is not in organization",
                    extra={
                        "organization_id": self.organization_id,
                        "user_login": user_info_response.get("login"),
                    },
                )
                raise AuthenticationException(
                    error_code=AUTHENTICATION_ERROR_CODES["GITHUB_USER_NOT_IN_ORG"],
                    error_message="GITHUB_USER_NOT_IN_ORG",
                )

        email = self.__get_email(headers=headers, user_info_response=user_info_response)
        self.logger.debug("Email found", extra={"email": email})

        # Accept standard OIDC claims (sub, picture) as fallbacks for GitHub-specific ones.
        provider_id = user_info_response.get("id") or user_info_response.get("sub")
        avatar = user_info_response.get("avatar_url") or user_info_response.get("picture")

        super().set_user_data({
            "email": email,
            "user": {
                "provider_id": provider_id,
                "email": email,
                "avatar": avatar,
                "first_name": user_info_response.get("name"),
                "last_name": user_info_response.get("family_name"),
                "is_password_autoset": True,
            },
        })
