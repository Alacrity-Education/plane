/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { layout, route } from "@react-router/dev/routes";
import type { RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Extended routes are deep-merged into the core routes by layout file (see ./helper.ts),
 * so the layout chain below must match the core layout file paths exactly.
 */
export const extendedRoutes: RouteConfigEntry[] = [
  layout("./(all)/layout.tsx", [
    layout("./(all)/[workspaceSlug]/layout.tsx", [
      layout("./(all)/[workspaceSlug]/(projects)/layout.tsx", [
        // ------------------------------------------------------------------
        // WORKSPACE WIKI
        // ------------------------------------------------------------------
        // Wiki pages list
        layout("./(all)/[workspaceSlug]/(projects)/wiki/(list)/layout.tsx", [
          route(":workspaceSlug/wiki", "./(all)/[workspaceSlug]/(projects)/wiki/(list)/page.tsx"),
        ]),
        // Wiki page detail
        layout("./(all)/[workspaceSlug]/(projects)/wiki/(detail)/layout.tsx", [
          route(":workspaceSlug/wiki/:pageId", "./(all)/[workspaceSlug]/(projects)/wiki/(detail)/[pageId]/page.tsx"),
        ]),
      ]),
    ]),
  ]),
];
