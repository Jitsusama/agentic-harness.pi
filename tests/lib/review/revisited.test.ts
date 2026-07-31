/**
 * Whether you have reviewed this before, and whether it has moved.
 *
 * The claim being tested is narrow on purpose: this says a change moved, not
 * what changed in it. The four answers exist because a caller acts differently
 * on each, and the one that would be easiest to collapse is the one that must
 * not be: a backend that will not say which commit is on top has to read
 * differently from a change that genuinely did not move.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeRef, Proposal } from "../../../lib/review/change.js";
import {
	createVisitLog,
	describeVisit,
	sinceLastVisit,
	type Visit,
} from "../../../lib/review/revisited.js";

const REF: ChangeRef = {
	provider: "github",
	repo: { key: "github:Jitsusama/agentic-harness.pi" },
	id: "425",
	label: "Jitsusama/agentic-harness.pi#425",
};
const OTHER: ChangeRef = {
	...REF,
	id: "426",
	label: "Jitsusama/agentic-harness.pi#426",
};

const built: string[] = [];
afterEach(() => {
	for (const dir of built.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "visits-"));
	built.push(dir);
	return dir;
}

/** A proposal sitting at a commit. */
function at(commit?: string): Proposal {
	return {
		ref: REF,
		title: "A change",
		state: "open",
		author: { id: "someone" },
		base: "main",
		head: "topic",
		...(commit === undefined ? {} : { headCommit: commit }),
	} as Proposal;
}

describe("recording that you reviewed something", () => {
	it("reads back the visit it recorded", () => {
		const log = createVisitLog(scratch());

		log.record(REF, { commit: "abc1234", at: "2026-07-30T01:00:00Z" });

		expect(log.last(REF)).toMatchObject({ commit: "abc1234" });
	});

	it("keeps changes apart", () => {
		const log = createVisitLog(scratch());

		log.record(REF, { commit: "aaa", at: "2026-07-30T01:00:00Z" });

		expect(log.last(OTHER)).toBeUndefined();
	});

	it("keeps only the most recent visit to one change", () => {
		// A review supersedes the one before it: the question is where the
		// change stood when you last looked, not every time you have looked.
		const log = createVisitLog(scratch());

		log.record(REF, { commit: "old", at: "2026-07-29T01:00:00Z" });
		log.record(REF, { commit: "new", at: "2026-07-30T01:00:00Z" });

		expect(log.last(REF)?.commit).toBe("new");
		expect(log.all()).toHaveLength(1);
	});

	it("says nothing has been reviewed when the directory is not there yet", () => {
		// A state, not a failure.
		const log = createVisitLog(join(tmpdir(), "no-such-visit-directory"));

		expect(log.all()).toEqual([]);
		expect(log.last(REF)).toBeUndefined();
	});

	it("skips a corrupt file rather than losing every other answer", () => {
		const dir = scratch();
		const log = createVisitLog(dir);
		log.record(REF, { commit: "good", at: "2026-07-30T01:00:00Z" });
		writeFileSync(join(dir, "broken.json"), "{ not json");

		expect(log.all()).toHaveLength(1);
	});

	it("orders newest first", () => {
		const log = createVisitLog(scratch());
		log.record(REF, { commit: "a", at: "2026-07-28T01:00:00Z" });
		log.record(OTHER, { commit: "b", at: "2026-07-30T01:00:00Z" });

		expect(log.all().map((one) => one.commit)).toEqual(["b", "a"]);
	});
});

describe("what has happened since you looked", () => {
	const visited: Visit = {
		key: "k",
		commit: "abc1234",
		at: "2026-07-29T01:00:00Z",
	};

	it("says so when you have never reviewed it", () => {
		expect(sinceLastVisit(undefined, at("abc1234"))).toEqual({ kind: "never" });
	});

	it("says it has not moved when the tip is where you left it", () => {
		expect(sinceLastVisit(visited, at("abc1234"))).toMatchObject({
			kind: "unmoved",
		});
	});

	it("says there is new work when the tip has moved", () => {
		const said = sinceLastVisit(visited, at("def5678"));

		expect(said).toMatchObject({ kind: "moved", commit: "def5678" });
		expect(describeVisit(said)).toContain("new work");
	});

	it("will not call a silent backend an unmoved change", () => {
		// Collapsing this into unmoved would make a change that moved without
		// saying so look like one that did not move at all.
		const said = sinceLastVisit(visited, at(undefined));

		expect(said).toMatchObject({ kind: "cannot-tell" });
		expect(describeVisit(said)).toContain("does not report");
	});

	it("will not compare against a commit it never recorded", () => {
		const said = sinceLastVisit(
			{ key: "k", at: "2026-07-29T01:00:00Z" },
			at("x"),
		);

		expect(said).toMatchObject({ kind: "cannot-tell" });
	});

	it("names the date and both commits when it moved", () => {
		const said = sinceLastVisit(visited, at("def5678901234"));

		const words = describeVisit(said);
		expect(words).toContain("2026-07-29");
		expect(words).toContain("abc1234");
		expect(words).toContain("def5678");
	});
});
