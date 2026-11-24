/**
 * A heavy call another handler refuses gives its claim back as pi ends
 * it: pi 1.6.0 answers a blocked call with no `tool_result`, so waiting
 * for the answer kept a build lease nobody used until the turn's end
 * (0IM95G, 24 November).
 */
import { describe, expect, it } from "vitest";
import { createHeavyCalls } from "../../../../extensions/mesh-workflow/leases.ts";
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

	it("gives back nothing more when it ends after answering", () => {
		const { events, calls } = tracked();
		calls.called("1", "nix build .#x");
		calls.answered("1", text("built"));

		calls.closed("1");

		expect(releases(events)).toEqual([{ release: "build" }]);
	});

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
