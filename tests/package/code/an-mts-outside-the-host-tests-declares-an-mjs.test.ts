/**
 * Outside the host tests, every `.mts` is a declaration beside its `.mjs`.
 *
 * Biome takes a `.d.mts` for the module it describes, so the linter's
 * import-extension rule maps `mts` to `mjs` everywhere but `tests/host`,
 * telling an importer to name the `.mjs`. A real `.mts` module there
 * would then be told to be imported as a `.mjs`, which tsc accepts, since
 * it resolves one to the other, and only node refuses at run time. This
 * holds the mapping's premise, so such a module fails here first.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Where the host tests keep `.mts` modules of their own, imported as written. */
const OWN_MODULES = "tests/host/";

describe("an .mts outside the host tests", () => {
	it("is a declaration with its .mjs beside it", () => {
		const tracked = execFileSync(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.mts"],
			{
				cwd: ROOT,
				encoding: "utf8",
			},
		)
			.split("\0")
			.filter((path) => path !== "" && !path.startsWith(OWN_MODULES));

		const strays = tracked.filter(
			(path) =>
				!path.endsWith(".d.mts") ||
				!existsSync(join(ROOT, path.replace(/\.d\.mts$/, ".mjs"))),
		);

		expect(tracked.length).toBeGreaterThan(0);
		expect(strays).toEqual([]);
	});
});
