/**
 * The charters the package ships have to read, and have to cover the
 * roster the package ships.
 *
 * A built-in reviewer whose charter is missing or will not parse is
 * refused when a round binds it, which on a fresh machine is every
 * council there is. So the check runs here, against the files, rather
 * than in the first round somebody asks.
 */

import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	BUILT_IN_ROSTER,
	builtInPersonaDir,
} from "../../extensions/review-integration/roster.ts";
import { chartersOnDisk } from "../../lib/core/review/index.ts";

describe("the personas the package ships", () => {
	it("all read as personas", async () => {
		const files = (await readdir(builtInPersonaDir())).filter((name) =>
			name.endsWith(".md"),
		);
		const charters = await chartersOnDisk(builtInPersonaDir());

		expect(charters.size).toBe(files.length);
		expect(files.length).toBe(7);
	});

	it("give every built-in reviewer a charter", async () => {
		const charters = await chartersOnDisk(builtInPersonaDir());

		for (const reviewer of BUILT_IN_ROSTER.reviewers) {
			expect(charters.get(reviewer.persona ?? "")).toBeTruthy();
		}
	});
});
