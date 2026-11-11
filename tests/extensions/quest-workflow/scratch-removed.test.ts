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
import {
	scratchLeftElsewhere,
	scratchRemoved,
} from "../../../extensions/quest-workflow/verbs/stage.ts";
import type { Measure } from "../../../lib/internal/quest/footprint.ts";
import type { QuestSession } from "../../../lib/quest/types.ts";

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

		expect(existsSync(dir), `${dir} is removed`).toBe(false);
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

		expect(existsSync(dir), `${dir} is kept`).toBe(true);
		expect(said).toContain(
			"since a process or a hosted conversation still works in it",
		);
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

function ranOn(hostId: string, terminalHost?: string): QuestSession {
	return {
		id: `session-on-${hostId}`,
		process: { hostId, pid: 1, startToken: "t" },
		...(terminalHost
			? { terminal: { driverId: "kitty", value: "1", hostId: terminalHost } }
			: {}),
	};
}

function shareRecord(files: Record<string, readonly string[]>): void {
	const shared = join(root, "state", "mycelium", "shared");
	mkdirSync(shared, { recursive: true });
	const entries = Object.fromEntries(
		Object.entries(files).map(([path, machines]) => [
			path,
			{
				hash: "h",
				version: Object.fromEntries(machines.map((m) => [m, 1])),
			},
		]),
	);
	writeFileSync(join(shared, `${ID}.json`), JSON.stringify({ files: entries }));
}

describe("scratchLeftElsewhere", () => {
	const env = () => ({ XDG_STATE_HOME: join(root, "state") });

	it("names each other machine the quest's sessions ran on", () => {
		const said = scratchLeftElsewhere(
			ID,
			[ranOn("optimus"), ranOn("equilibrius"), ranOn("penelope", "penelope")],
			"optimus",
			env(),
		);

		expect(said).toContain("may remain on equilibrius and penelope");
		expect(said).not.toContain("optimus");
		expect(said).toContain("this machine removes only its own");
	});

	it("names a machine a share copied the quest's scratch to", () => {
		shareRecord({
			"record/README.md": ["optimus", "equilibrius", "methuselah"],
			"notes/lab.md": ["optimus", "equilibrius"],
		});

		const said = scratchLeftElsewhere(ID, [], "optimus", env());

		expect(said).toContain("may remain on equilibrius,");
		expect(said, "a copy of the record alone is no scratch").not.toContain(
			"methuselah",
		);
	});

	it("says nothing when only this machine held its scratch", () => {
		shareRecord({ "record/README.md": ["optimus", "equilibrius"] });

		expect(scratchLeftElsewhere(ID, [ranOn("optimus")], "optimus", env())).toBe(
			undefined,
		);
	});
});
