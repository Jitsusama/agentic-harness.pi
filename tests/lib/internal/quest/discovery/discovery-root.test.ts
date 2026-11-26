/**
 * What discovery says of a quests root that isn't a folder of quests.
 *
 * A fresh data folder, such as the one an install's warm-up runs pi in,
 * has no quests root yet: that is an empty store, and saying it as a
 * layout fault put a false fault in the journal of every install. A
 * root that is there but can't be listed is a fault, and is said, as
 * is one behind something that isn't a folder or can't be searched.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverQuests } from "../../../../../lib/internal/quest/discovery/discovery.ts";
import { newPass } from "../../../../../lib/internal/quest/discovery/discovery-reads.ts";
import { discoverQuestsUncached } from "../../../../../lib/internal/quest/discovery/discovery-walk.ts";

const FAULT = "Quests root is not a readable directory.";

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
	expect(errors).toEqual([{ path: root, message: FAULT }]);
});

it("says a quests root that is a dangling link is no folder of quests", () => {
	const root = join(dir, "quests");
	symlinkSync(join(dir, "nowhere"), root);
	const { errors } = discoverQuestsUncached(root, newPass());
	expect(errors).toEqual([{ path: root, message: FAULT }]);
});

it("says a quests root behind a file, where its data folder should be", () => {
	const data = join(dir, "data");
	writeFileSync(data, "");
	const root = join(data, "quests");
	const { errors } = discoverQuestsUncached(root, newPass());
	expect(errors).toEqual([{ path: root, message: FAULT }]);
});

it("says a quests root whose folder above can't be searched", () => {
	const data = join(dir, "data");
	const root = join(data, "quests");
	mkdirSync(root, { recursive: true });
	chmodSync(data, 0o000);
	try {
		const { errors } = discoverQuestsUncached(root, newPass());
		expect(errors).toEqual([{ path: root, message: FAULT }]);
	} finally {
		chmodSync(data, 0o755);
	}
});

it("says, at a session's discovery, a root that turns from gone to unreadable", () => {
	const root = join(dir, "quests");
	expect(discoverQuests(root).errors, "not there yet").toEqual([]);
	writeFileSync(root, "");
	expect(
		discoverQuests(root).errors,
		"walked again, not answered from the gone root's walk",
	).toEqual([{ path: root, message: FAULT }]);
});
