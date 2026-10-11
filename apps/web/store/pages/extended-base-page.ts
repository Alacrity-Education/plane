/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { makeObservable, observable } from "mobx";
import type { TPage, TPageExtended } from "@plane/types";
import type { CoreRootStore } from "@/store/root.store";
import type { TBasePageServices } from "@/store/pages/base-page";

export type TExtendedPageInstance = TPageExtended & {
  asJSONExtended: TPageExtended;
};

export class ExtendedBasePage implements TExtendedPageInstance {
  // wiki page properties
  parent: string | null | undefined;
  is_global: boolean | undefined;
  sort_order: number | undefined;
  sub_pages_count: number | undefined;

  // oxlint-disable-next-line no-unused-vars
  constructor(store: CoreRootStore, page: TPage, services: TBasePageServices) {
    this.parent = page?.parent ?? undefined;
    this.is_global = page?.is_global ?? undefined;
    this.sort_order = page?.sort_order ?? undefined;
    this.sub_pages_count = page?.sub_pages_count ?? undefined;

    makeObservable(this, {
      parent: observable.ref,
      is_global: observable.ref,
      sort_order: observable.ref,
      sub_pages_count: observable.ref,
    });
  }

  get asJSONExtended(): TExtendedPageInstance["asJSONExtended"] {
    return {
      parent: this.parent,
      is_global: this.is_global,
      sort_order: this.sort_order,
      sub_pages_count: this.sub_pages_count,
    };
  }
}
