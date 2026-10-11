import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main";

const run = async (argv: string[], env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { env, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("cli", () => {
  it("prints help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--callouts <mode>");
  });

  it("requires the environment unless --from-fixture is used", async () => {
    const { code, err } = await run([]);
    expect(code).toBe(2);
    expect(err).toContain("PLANE_URL, PLANE_WORKSPACE_SLUG, PLANE_API_KEY");
  });

  it("validates flags", async () => {
    expect((await run(["--callouts", "nope"])).code).toBe(2);
    expect((await run(["--concurrency", "0"])).code).toBe(2);
    expect((await run(["--bogus"])).code).toBe(2);
  });

  it("syncs from a fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiki-cli-"));
    try {
      const fixture = new URL("./fixtures/wiki-fixture.json", import.meta.url).pathname;
      const { code, out } = await run([
        "--from-fixture",
        fixture,
        "--out",
        join(dir, "wiki"),
        "--assets",
        join(dir, "assets"),
        "--cache",
        join(dir, "cache/manifest.json"),
        "--callouts",
        "html",
      ]);
      expect(code).toBe(0);
      expect(out).toContain("9 page(s)");
      expect(await readdir(join(dir, "wiki"))).toContain("engineering");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
