/**
 * A session's branch as tagging reads it, folded as the branch grows:
 * at every leaf it agrees with reading the whole branch.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	readTags,
	SELECTION_TAGS_ENTRY,
	taggedBranchAt,
} from "../../../../lib/compaction/selection/tags.ts";
import { unitsOf } from "../../../../lib/compaction/selection/units.ts";

/** What reading the whole branch says, to hold the fold to. */
function wholeBranch(manager: SessionManager) {
	const branch = manager.getBranch();
	let start = 0;
	branch.forEach((entry, at) => {
		if (entry.type === "compaction") start = at + 1;
	});
	return {
		recorded: readTags(branch),
		live: branch.slice(start).map((entry) => entry.id),
	};
}

/** The fold's reading, copied, since later entries add to the live one. */
function folded(manager: SessionManager) {
	const { recorded, live } = taggedBranchAt(manager);
	return {
		recorded: {
			kinds: new Map(recorded.kinds),
			entries: new Set(recorded.entries),
		},
		live: live.map((entry) => entry.id),
	};
}

function say(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: 0 });
}

/** Tags the message `id` names as a rule, as the tagger records it. */
function tag(manager: SessionManager, id: string): void {
	const entry = manager.getEntry(id);
	if (entry === undefined) throw new Error(`no entry ${id}`);
	manager.appendCustomEntry(SELECTION_TAGS_ENTRY, {
		entryId: id,
		units: unitsOf(entry).map((unit) => ({ hash: unit.hash, kinds: ["rule"] })),
	});
}

describe("a session's branch as tagging reads it", () => {
	it("agrees with the whole branch at every leaf, through a compaction and onto another branch", () => {
		const manager = SessionManager.inMemory("/tmp");
		const asked: [ReturnType<typeof folded>, ReturnType<typeof wholeBranch>][] =
			[];
		const ask = () => asked.push([folded(manager), wholeBranch(manager)]);

		ask();
		const first = say(manager, "Always sign every commit.");
		ask();
		tag(manager, first);
		ask();
		const second = say(manager, "Keep the footer quiet once shut down.");
		tag(manager, second);
		ask();
		manager.appendCompaction("Earlier, two rules.", second, 1_000);
		ask();
		const third = say(manager, "Read only what the branch gained.");
		ask();
		tag(manager, third);
		ask();
		manager.branch(first);
		ask();
		say(manager, "A different turn from the first message on.");
		ask();

		for (const [fromFold, fromBranch] of asked) {
			expect(fromFold).toEqual(fromBranch);
		}
		expect(asked).toHaveLength(9);
		// Just after the compaction both rules are known and nothing is
		// live; the other branch, which left before any tag, knows none.
		const compacted = asked.at(4)?.[1];
		expect(compacted?.live).toEqual([]);
		expect(compacted?.recorded.kinds.size).toBe(2);
		expect(asked.at(-1)?.[1].recorded.kinds.size).toBe(0);
		expect(asked.at(-1)?.[1].live).toHaveLength(2);
	});

	it("reads nothing of an empty session", () => {
		const { recorded, live } = taggedBranchAt(SessionManager.inMemory("/tmp"));
		expect(live).toEqual([]);
		expect(recorded.kinds.size).toBe(0);
	});
});
