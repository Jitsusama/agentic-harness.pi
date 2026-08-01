import { describe, expect, it } from "vitest";
import {
	lensForField,
	reversibleFields,
} from "../../../../lib/internal/quest/fields";
import type { QuestFrontMatter } from "../../../../lib/quest/types";

function frontMatter(): QuestFrontMatter {
	return {
		id: "QEST-20260101-AAAAAA",
		kind: "quest",
		parent: null,
		status: "active",
		priority: "queued",
		rank: 3,
		started: "2026-01-01",
		updated: "2026-01-01",
		aliases: [],
		sessions: [],
	};
}

describe("the table that says how to read and write a quest field", () => {
	it("reads each reversible field as the journal records it", () => {
		const fm = frontMatter();

		const read = Object.fromEntries(
			reversibleFields().map((f) => [f, lensForField(f)?.read(fm)]),
		);

		expect(read).toEqual({
			parent: null,
			status: "active",
			priority: "queued",
			rank: "3",
			kind: "quest",
		});
	});

	it("writes a value back so reading it returns what was written", () => {
		const lens = lensForField("priority");

		const written = lens?.write(frontMatter(), "driving");

		expect(written?.ok).toBe(true);
		expect(written?.ok === true && lens?.read(written.fm)).toBe("driving");
	});

	it("refuses a value outside the field's vocabulary", () => {
		// The old undo cast a journalled value straight to the field type.
		// A journal hand-edited or written by an older build could carry a
		// word the vocabulary lost, and the cast would write it.
		const written = lensForField("status")?.write(frontMatter(), "sleepy");

		expect(written?.ok).toBe(false);
	});

	it("names the offending value and the vocabulary it missed", () => {
		const written = lensForField("status")?.write(frontMatter(), "sleepy");
		const reason = written?.ok === false ? written.reason : "";

		expect(reason).toContain("sleepy");
		expect(reason).toContain("concluded");
	});

	it("has no lens for a field that does not live on a quest README", () => {
		// `stage` is journallable but belongs to a document. Undo skips it
		// by finding no lens, rather than by a sentinel that happens never
		// to match.
		expect(lensForField("stage")).toBeUndefined();
	});

	it("offers a lens for every field it calls reversible", () => {
		for (const field of reversibleFields()) {
			expect(lensForField(field), field).toBeDefined();
		}
	});

	it("clears a nullable field when the journal recorded null", () => {
		// Undoing a reparent to top level means writing null back, which is
		// a value and not an absence.
		const fm = { ...frontMatter(), parent: "QEST-20260101-BBBBBB" };

		const written = lensForField("parent")?.write(fm, null);

		expect(written?.ok === true && written.fm.parent).toBeNull();
	});

	it("refuses a rank that is not a number", () => {
		const written = lensForField("rank")?.write(frontMatter(), "eleventh");

		expect(written?.ok).toBe(false);
	});
});
