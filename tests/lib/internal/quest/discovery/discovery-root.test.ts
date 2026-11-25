/**
 * What discovery says of a quests root that isn't a folder of quests.
 *
 * A fresh data folder, such as the one an install's warm-up runs pi in,
 * has no quests root yet: that is an empty store, and saying it as a
 * layout fault put a false fault in the journal of every install. A
 * root that is there but can't be listed is a fault, and is said.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { newPass } from "../../../../../lib/internal/quest/discovery/discovery-reads.ts";
import { discoverQuestsUncached } from "../../../../../lib/internal/quest/discovery/discovery-walk.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "discovery-root-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

it("reads a quests root that isn't there yet as an empty store", () => {
	const { index, errors } = discoverQuestsUncached(
		join(dir, "quests"),
		newPass(),
	);
	expect(index.quests.size).toBe(0);
	expect(errors).toEqual([]);
});

it("says a quests root that is a file is no folder of quests", () => {
	const root = join(dir, "quests");
	writeFileSync(root, "");
	const { index, errors } = discoverQuestsUncached(root, newPass());
	expect(index.quests.size).toBe(0);
	expect(errors).toEqual([
		{ path: root, message: "Quests root is not a readable directory." },
	]);
});
