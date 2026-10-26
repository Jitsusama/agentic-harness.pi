/**
 * What a sealed quest does with its scratch folder, and says it did.
 *
 * A cache goes with its owner, not with its age, so conclude removes the
 * whole scratch folder and says how much that freed. One a process still
 * works in stays for the disk guard, and the answer says so.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchRemoved } from "../../../extensions/quest-workflow/verbs/stage.ts";
import type { Measure } from "../../../lib/internal/quest/footprint.ts";

const ID = "QEST-20261001-AAAAAA";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "scratch-removed-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const holds =
	(bytes: number, complete = true): Measure =>
	async () => ({ bytes, complete });

const nobody = () => [];

describe("scratchRemoved", () => {
	it("removes the scratch folder and says what it held", async () => {
		const dir = join(root, ID);
		mkdirSync(join(dir, "lab"), { recursive: true });
		writeFileSync(join(dir, "lab", "results.csv"), "x");

		const said = await scratchRemoved(
			ID,
			undefined,
			holds(2.5e9),
			root,
			nobody,
		);

		expect(existsSync(dir)).toBe(false);
		expect(said).toBe("Removed its scratch folder, which held 2.5 GB.");
	});

	it("says it was cut short rather than giving a wrong figure", async () => {
		mkdirSync(join(root, ID));

		const said = await scratchRemoved(
			ID,
			undefined,
			holds(3e9, false),
			root,
			nobody,
		);

		expect(said).toContain("which held at least 3.0 GB");
	});

	it("leaves one a process still works in, for the disk guard", async () => {
		const dir = join(root, ID);
		mkdirSync(dir);

		const said = await scratchRemoved(ID, undefined, holds(1e9), root, () => [
			7,
		]);

		expect(existsSync(dir)).toBe(true);
		expect(said).toContain("since a process still works in it");
	});

	it("says nothing when the quest has no scratch folder", async () => {
		expect(
			await scratchRemoved(ID, undefined, async () => undefined, root, nobody),
		).toBe(undefined);
		expect(
			await scratchRemoved(
				null,
				undefined,
				async () => undefined,
				root,
				nobody,
			),
		).toBe(undefined);
	});
});
