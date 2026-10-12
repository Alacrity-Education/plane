#!/usr/bin/env node
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { main } from "./main";

main(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => {
    process.exitCode = code;
    return code;
  },
  (error: unknown) => {
    process.stderr.write(`plane-wikijs-import failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
);
