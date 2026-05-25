/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type {
  IFormattedInstanceConfiguration,
  TInstanceAuthenticationModes,
  TInstanceConfigurationKeys,
} from "@plane/types";

/**
 * Checks if a given authentication method can be disabled.
 * @param configKey - The configuration key to check.
 * @param authModes - The authentication modes to check.
 * @param formattedConfig - The formatted configuration to check.
 * @returns True if the authentication method can be disabled, false otherwise.
 */
export const canDisableAuthMethod = (
  _configKey: TInstanceConfigurationKeys,
  _authModes: TInstanceAuthenticationModes[],
  _formattedConfig: IFormattedInstanceConfiguration | undefined
): boolean =>
  // Company SSO (Authentik) is always active, so disabling any individual
  // email/password method never locks users out.
  true;
