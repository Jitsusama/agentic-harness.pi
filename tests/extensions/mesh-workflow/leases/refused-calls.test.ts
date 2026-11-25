/**
 * A heavy call another handler refuses gives its claim back as pi ends
 * it: pi 1.6.0 answers a blocked call with no `tool_result`, so waiting
 * for the answer kept a build lease nobody used until the turn's end
 * (0IM95G, 24 November).
 */
import { describe, expect, it } from "vitest";
import {
	createEditNotes,
	createHeavyCalls,
} from "../../../../extensions/mesh-workflow/leases.ts";
import type { LeaseEvent } from "../../../../lib/mesh/lease.ts";

const text = (words: string) => [{ type: "text", text: words }];

const tracked = () => {
	const events: LeaseEvent[] = [];
	const calls = createHeavyCalls((event) => events.push(event));
	return { events, calls };
};

const releases = (events: readonly LeaseEvent[]) =>
	events.filter((event) => "release" in event);

describe("a heavy call", () => {
	it("gives its work back when it ends without answering, as a refused call does", () => {
		const { events, calls } = tracked();
		calls.called("1", "nix build .#x");

		calls.closed("1");

		expect(releases(events)).toEqual([{ release: "build" }]);
		expect(calls.held()).toEqual([]);
	});

	// pi answers before it ends a call (agent-loop's finalize, then
	// tool_execution_end), so an answered call's end must change nothing:
	// this is the case that pins it, since only a hand-off outlives one.
	it("keeps a job it handed off past its end, until the job ends", () => {
		const { events, calls } = tracked();
		calls.called("1", "./watch.sh");
		calls.answered(
			"1",
			text("Running as background command j7. Its result will arrive later."),
		);

		calls.closed("1");
		expect(releases(events), "the job still runs").toEqual([]);

		calls.finished("1");
		expect(releases(events)).toEqual([
			{ release: "background j7: ./watch.sh" },
		]);
	});

	it("keeps work another call shares when one of them is refused", () => {
		const { events, calls } = tracked();
		calls.called("1", "nix build .#x");
		calls.called("2", "nix build .#y");

		calls.closed("2");
		expect(releases(events)).toEqual([]);
		expect(calls.held()).toEqual([["1", "build"]]);
	});
});

describe("an edit's note", () => {
	it("goes when another handler refuses the edit, so a later call of that id carries none", () => {
		const notes = createEditNotes();
		notes.met("1", { note: "a peer edits this file too" });

		notes.closed("1");

		expect(notes.noted("1", text("edited"))).toBeUndefined();
	});

	it("stays for the result of an edit that ran", () => {
		const notes = createEditNotes();
		notes.met("1", { note: "a peer edits this file too" });

		expect(notes.noted("1", text("edited"))).toEqual([
			...text("edited"),
			...text("a peer edits this file too"),
		]);
	});
});
