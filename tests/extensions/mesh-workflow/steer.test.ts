/**
 * What a session reads of a steer: the person's words, saying where they
 * came from, or a machine's, saying they aren't the person's.
 */

import { describe, expect, it } from "vitest";
import { steerText } from "../../../extensions/mesh-workflow/steer.ts";

describe("a steer as the session reads it", () => {
	it("is the person asking, to be answered first, when they or nobody named wrote it", () => {
		expect(
			steerText({ text: "hello", from: "joel", file: "f" }, { busy: true }),
		).toBe(
			"[Joel is asking from outside this window while this session works: answer first, in a line or two, then carry on.]\n\nhello",
		);
		expect(steerText({ text: "hello", file: "f" }, { busy: false })).toBe(
			"[The person is asking from outside this window: answer first, in a line or two, then do what is asked.]\n\nhello",
		);
		expect(
			steerText({ text: "hi", from: "person", file: "f" }, { busy: false }),
		).toMatch(/^\[The person is asking/);
	});

	it("never says a reply may go unread", () => {
		for (const busy of [true, false]) {
			expect(
				steerText({ text: "hello", from: "joel", file: "f" }, { busy }),
			).not.toMatch(/unread/);
		}
	});

	it("says a machine's words aren't the person's", () => {
		const said = steerText(
			{
				text: "this machine leaves at 17:00",
				from: "machine",
				file: "f",
			},
			{ busy: true },
		);
		expect(said).toMatch(
			/^\[Said by this machine's mycelium node, not by the person/,
		);
		expect(said).toMatch(/this machine leaves at 17:00$/);
	});

	it("names the machine's program that wrote it, when it says", () => {
		const said = steerText(
			{
				text: "no builder answers",
				from: "machine",
				by: "nix-offload",
				file: "f",
			},
			{ busy: false },
		);
		expect(said).toMatch(
			/^\[Said by this machine's nix-offload, not by the person/,
		);
	});
});
