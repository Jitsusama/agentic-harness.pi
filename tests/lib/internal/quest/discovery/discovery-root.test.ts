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
import {
	discoverySignature,
	newPass,
} from "../../../../../lib/internal/quest/discovery/discovery-reads.ts";
import {
	discoverQuestsUncached,
	merged,
} from "../../../../../lib/internal/quest/discovery/discovery-walk.ts";
import { readTreeOffThread } from "../../../../../lib/internal/quest/discovery/off-thread.ts";

const FAULT = "Quests root is not a readable directory.";
/** How long a signing's thread may read before it counts as hung. */
const THREAD_HANGS_AFTER_MS = 30_000;

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

it("reads a quests root whose data folder isn't there yet either as an empty store", () => {
	const { errors } = discoverQuestsUncached(
		join(dir, "data", "quests"),
		newPass(),
	);
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

it("says a quests root that is a dangling link named with a trailing slash", () => {
	const root = join(dir, "quests");
	symlinkSync(join(dir, "nowhere"), root);
	const slashed = `${root}/`;
	const { errors } = discoverQuestsUncached(slashed, newPass());
	expect(errors).toEqual([{ path: slashed, message: FAULT }]);
});

it("says a quests root under a data folder linked to somewhere not there", () => {
	// As a data folder on a volume not mounted: a store gone offline.
	const data = join(dir, "data");
	symlinkSync(join(dir, "unmounted", "pi"), data);
	const root = join(data, "quests");
	const { errors } = discoverQuestsUncached(root, newPass());
	expect(errors).toEqual([{ path: root, message: FAULT }]);
});

it("reads a quests root under a data folder linked to a folder as empty until made", () => {
	const real = join(dir, "real");
	mkdirSync(real);
	const data = join(dir, "data");
	symlinkSync(real, data);
	const { errors } = discoverQuestsUncached(join(data, "quests"), newPass());
	expect(errors).toEqual([]);
});

it("says a quests root behind a file, where its data folder should be", () => {
	const data = join(dir, "data");
	writeFileSync(data, "");
	const root = join(data, "quests");
	const { errors } = discoverQuestsUncached(root, newPass());
	expect(errors).toEqual([{ path: root, message: FAULT }]);
});

it.skipIf(process.getuid?.() === 0)(
	"says a quests root whose folder above can't be searched",
	() => {
		// Root reads a folder whatever its mode, so it never sees the fault.
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
	},
);

it("walks the root as it signed it, though it was made in between", () => {
	const root = join(dir, "quests");
	const pass = newPass();
	expect(discoverySignature(root, pass)).toBe("absent:gone");
	mkdirSync(root);
	const { errors } = discoverQuestsUncached(root, pass);
	expect(errors, "no fault for a root made since it was listed").toEqual([]);
});

it("has a signing's thread say how a root that won't list stands", async () => {
	const gone = join(dir, "quests");
	const file = join(dir, "file");
	writeFileSync(file, "");
	const [ofGone, ofFile] = await Promise.all(
		[gone, file].map((root) => readTreeOffThread(root, THREAD_HANGS_AFTER_MS)),
	);
	expect(ofGone?.pass.unlisted.get(gone)).toBe("gone");
	expect(ofFile?.pass.unlisted.get(file)).toBe("unreadable");
});

it("keeps the root's fault through a merge until the root lists again", () => {
	const root = join(dir, "quests");
	const nothing = {
		index: { quests: new Map(), children: new Map() },
		errors: [],
	};
	const faulted = { ...nothing, errors: [{ path: root, message: FAULT }] };
	const none = new Set<string>();
	expect(merged(root, faulted, none, nothing, false).errors).toEqual(
		faulted.errors,
	);
	expect(merged(root, faulted, none, nothing, true).errors).toEqual([]);
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
