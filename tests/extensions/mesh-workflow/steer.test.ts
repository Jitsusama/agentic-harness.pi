/**
 * What a session reads of a steer: the person's words, saying where they
 * came from, or a machine's, saying they aren't the person's.
 */

import { describe, expect, it } from "vitest";
import { steerText } from "../../../extensions/mesh-workflow/steer.ts";

describe("a steer as the session reads it", () => {
	it("is the person's word when the person, or nobody named, wrote it", () => {
		expect(steerText({ text: "pivot", from: "joel", file: "f" })).toMatch(
			/^\[Steered by joel from outside this window/,
		);
		expect(steerText({ text: "pivot", file: "f" })).toMatch(
			/^\[Steered by the person/,
		);
	});

	it("says a machine's words aren't the person's", () => {
		const said = steerText({
			text: "this machine leaves at 17:00",
			from: "machine",
			file: "f",
		});
		expect(said).toMatch(
			/^\[Said by this machine's mycelium node, not by the person/,
		);
		expect(said).toMatch(/this machine leaves at 17:00$/);
	});
});
