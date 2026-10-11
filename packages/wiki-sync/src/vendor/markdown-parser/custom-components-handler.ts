/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Handle } from "hast-util-to-mdast";
// local imports
import { createTextNode } from "./common";
import type { TCustomComponentsMetaData } from "./types";

type TArgs = {
  metaData: TCustomComponentsMetaData;
};

export const parseCustomComponents = (args: TArgs): Record<string, Handle> => {
  const { metaData } = args;

  const getFileAssetDetails = (id: string) => metaData.file_assets.find((asset) => asset.id === id);

  const fileAssetImage: Handle = (_state, node) => {
    const properties = node.properties || {};
    const src = String(properties.src);
    const fileAssetDetails = getFileAssetDetails(src);
    if (!src || !fileAssetDetails) return createTextNode("");
    return createTextNode(`![${fileAssetDetails.name}](${fileAssetDetails.url})`);
  };

  return {
    "image-component": fileAssetImage,
    // Excalidraw drawings are exported as a PNG file asset, rendered like an image.
    "excalidraw-component": fileAssetImage,
    img: (_state, node) => {
      const properties = node.properties || {};
      const src = String(properties.src);
      // wiki-sync fix: upstream dropped the image when alt="" and printed "![undefined](...)" when
      // the attribute was missing (legacy TipTap images never carry an alt).
      const alt = properties.alt ? String(properties.alt) : "";
      if (!properties.src || !src) return createTextNode("");
      return createTextNode(`![${alt}](${src})`);
    },
    "mention-component": (_state, node) => {
      const properties = node.properties || {};
      const mentionType = String(properties.entity_name);

      let url: string = "";
      let tag: string = "@";
      if (mentionType === "user_mention") {
        const userId = String(properties.entity_identifier);
        const userDetails = metaData.user_mentions.find((user) => user.id === userId);
        if (!userDetails) return createTextNode("");
        url = userDetails.url || "";
        tag = `@${userDetails.display_name || "Unknown user"}`;
      }

      return createTextNode(`[${tag}](${url}) `);
    },
  };
};
