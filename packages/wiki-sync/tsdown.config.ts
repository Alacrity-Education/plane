import { defineConfig } from "tsdown";

// Every runtime library is a devDependency on purpose: tsdown bundles everything that is not
// listed in `dependencies`/`peerDependencies`, so dist/ is self-contained and the CLI can be
// installed from a git tag or an `npm pack` tarball without resolving workspace packages.
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  fixedExtension: false,
  dts: true,
  clean: true,
});
