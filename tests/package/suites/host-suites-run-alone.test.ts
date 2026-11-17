/**
 * Every whole-host suite is named in vitest's process lane.
 *
 * Each file in tests/host/end-to-end starts a host, which spawns node
 * from node, so it runs one file at a time in the process lane, the one
 * `pnpm test:host` runs. The lane names its files one by one, and a file
 * left out falls into the unit lane, where no host's pi is found: its
 * cases skip themselves, and the run reads as green though none of them
 * ran. E29 and E30 sat out that way.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SUITES = "tests/host/end-to-end";

/** Each suite under `dir` that the config text doesn't name. */
function unnamed(config: string, dir: string, files: string[]): string[] {
	return files
		.filter((file) => file.endsWith(".test.ts"))
		.map((file) => `${dir}/${file}`)
		.filter((path) => !config.includes(`"${path}"`));
}

it("names every whole-host suite in the process lane", () => {
	const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
	const files = readdirSync(join(ROOT, SUITES));
	expect(unnamed(config, SUITES, files)).toEqual([]);
});

it("tells a named suite from one left out", () => {
	const config = '\t"tests/host/end-to-end/a.test.ts",\n';
	expect(
		unnamed(config, SUITES, ["a.test.ts", "b.test.ts", "README.md"]),
	).toEqual(["tests/host/end-to-end/b.test.ts"]);
});
