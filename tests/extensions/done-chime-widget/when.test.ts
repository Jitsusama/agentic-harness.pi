import { describe, expect, it } from "vitest";
import {
	type Arrival,
	heardAt,
	LOOKED_AWAY_MS,
	rings,
	type Settled,
} from "../../../extensions/done-chime-widget/when.ts";
import { automatedText } from "../../../lib/internal/automated.ts";

const TYPED_AT = 1_000_000;

/** A run the person typed, settled long after, with them at the window. */
function settled(overrides: Partial<Settled> = {}): Settled {
	return {
		attended: true,
		heardAt: TYPED_AT,
		at: TYPED_AT + LOOKED_AWAY_MS + 1,
		aborted: false,
		away: false,
		...overrides,
	};
}

const typed = (text = "fix the flaky test"): Arrival => ({
	kind: "input",
	source: "interactive",
	text,
});

describe("whether a settled run rings", () => {
	it("rings for a run the person typed that outlasted their glance", () => {
		expect(rings(settled()), "a typed run that outlasted the glance").toBe(
			true,
		);
	});

	it("stays quiet for a run that ended while they were still watching", () => {
		expect(
			rings(settled({ at: TYPED_AT + LOOKED_AWAY_MS - 1 })),
			"a run that ended 1ms inside the glance",
		).toBe(false);
	});

	it("stays quiet for a run nobody typed", () => {
		expect(rings(settled({ heardAt: undefined })), "a run nobody typed").toBe(
			false,
		);
	});

	it("stays quiet where nobody can be at the session", () => {
		expect(rings(settled({ attended: false })), "an unattended session").toBe(
			false,
		);
	});

	it("stays quiet for a run the person stopped, since they are right there", () => {
		expect(rings(settled({ aborted: true })), "a run the person stopped").toBe(
			false,
		);
	});

	it("stays quiet while the person is away from the machine", () => {
		expect(
			rings(settled({ away: true })),
			"a person away from the machine",
		).toBe(false);
	});
});

describe("when the person was last heard from in a run", () => {
	it("is when they typed the message that started it", () => {
		expect(heardAt(undefined, typed(), TYPED_AT)).toBe(TYPED_AT);
	});

	it("moves to the last thing they typed into it", () => {
		const steered: Arrival = {
			kind: "input",
			source: "interactive",
			text: "and the docs",
			streamingBehavior: "steer",
		};
		expect(heardAt(TYPED_AT, steered, TYPED_AT + 5)).toBe(TYPED_AT + 5);
	});

	it("is never for a run another extension's message started", () => {
		const steer: Arrival = {
			kind: "input",
			source: "extension",
			text: "[Steered by the person from outside this window.]\n\nhi",
		};
		expect(heardAt(TYPED_AT, steer, TYPED_AT + 5)).toBeUndefined();
	});

	it("is never for a run a custom message started", () => {
		expect(heardAt(TYPED_AT, { kind: "message" }, TYPED_AT + 5)).toBe(
			undefined,
		);
	});

	it("is never for a run started over RPC", () => {
		const rpc: Arrival = { kind: "input", source: "rpc", text: "go" };
		expect(heardAt(undefined, rpc, TYPED_AT)).toBeUndefined();
	});

	it("is never for text the harness sent, even through the editor", () => {
		const resumed = typed(automatedText("the context was compacted", "Go."));
		expect(heardAt(undefined, resumed, TYPED_AT)).toBeUndefined();
	});

	it("keeps the person's run theirs when a message joins it under way", () => {
		const joined: Arrival = {
			kind: "input",
			source: "extension",
			text: "background work is done",
			streamingBehavior: "followUp",
		};
		expect(heardAt(TYPED_AT, joined, TYPED_AT + 5)).toBe(TYPED_AT);
	});
});
