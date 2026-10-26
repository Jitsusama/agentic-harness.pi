/**
 * The structural journal: one file every session writes, each entry
 * saying whose it is, so a session finds only its own newest change,
 * sees who changed its quests since, and drops one entry by its id.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	changedSince,
	dropStructuralOp,
	lastStructuralOp,
	ownNewestStructuralOp,
	recordStructuralOp,
	setJournalSession,
} from "../../../../lib/internal/quest/structural-journal";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "journal-"));
	setJournalSession(undefined);
});

afterEach(() => {
	setJournalSession(undefined);
	rmSync(root, { recursive: true, force: true });
});

/** Record a change to one quest's parent as this session. */
function reparentAs(session: string | undefined, id: string): void {
	setJournalSession(session);
	recordStructuralOp(root, "reparent", [
		{ id, field: "parent", old: null, new: "QEST-P" },
	]);
}

describe("structural journal", () => {
	it("returns undefined when no op has been recorded", () => {
		expect(lastStructuralOp(root)).toBeUndefined();
	});

	it("stamps each entry with a time, an id of its own and its session", () => {
		reparentAs("session-a", "QEST-1");

		const last = lastStructuralOp(root);
		expect(Number.isNaN(Date.parse(last?.ts ?? ""))).toBe(false);
		expect(last?.entry).toMatch(/^[0-9a-f-]{36}$/);
		expect(last?.session).toBe("session-a");
	});

	it("finds a session's own newest change, never another's", () => {
		reparentAs("session-a", "QEST-1");
		reparentAs("session-b", "QEST-2");

		expect(ownNewestStructuralOp(root, "session-a")?.changes[0]?.id).toBe(
			"QEST-1",
		);
		expect(ownNewestStructuralOp(root, "session-c")).toBeUndefined();
	});

	it("leaves an entry with no session to nobody", () => {
		// As every entry written before entries said whose they were.
		reparentAs(undefined, "QEST-7SU7HB");

		expect(ownNewestStructuralOp(root, "session-a")).toBeUndefined();
	});

	it("names the later changes to the same quests, and only those", () => {
		reparentAs("session-a", "QEST-1");
		reparentAs("session-b", "QEST-2");
		reparentAs("session-b", "QEST-1");
		const own = ownNewestStructuralOp(root, "session-a");
		if (!own) throw new Error("session-a's change was not found");

		const since = changedSince(root, own);

		expect(since.map((one) => one.changes[0]?.id)).toEqual(["QEST-1"]);
		expect(since[0]?.session).toBe("session-b");
	});

	it("drops one entry by its id, leaving every other where it was", () => {
		reparentAs("session-a", "QEST-1");
		reparentAs("session-b", "QEST-2");
		const own = ownNewestStructuralOp(root, "session-a");
		if (!own?.entry) throw new Error("session-a's change was not found");

		dropStructuralOp(root, own.entry);

		expect(ownNewestStructuralOp(root, "session-a")).toBeUndefined();
		expect(lastStructuralOp(root)?.session).toBe("session-b");
	});

	it("keeps what could not be undone in the entry's place", () => {
		reparentAs("session-a", "QEST-1");
		reparentAs("session-b", "QEST-2");
		const own = ownNewestStructuralOp(root, "session-a");
		if (!own?.entry) throw new Error("session-a's change was not found");
		const residue = own.changes;

		dropStructuralOp(root, own.entry, residue);

		expect(ownNewestStructuralOp(root, "session-a")?.entry).toBe(own.entry);
		expect(lastStructuralOp(root)?.session).toBe("session-b");
	});
});
