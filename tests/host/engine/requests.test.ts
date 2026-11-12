/** What a conversation's extensions are told at its start, from the open or adopt that made it. */
import { describe, expect, it } from "vitest";
import { hintsFor } from "../../../host/engine/requests.ts";

const QUEST = "QEST-20261112-ABCDEF";
const open = {
	v: 1,
	id: "o",
	op: "open",
	cwd: "/repo",
	attended: true,
} as const;

describe("a conversation's launch hints", () => {
	it("say its quest and first words, as plain pi's environment would", () => {
		expect(hintsFor({ ...open, quest: QUEST, first: "carry on" })).toEqual({
			questId: QUEST,
			firstWords: "carry on",
		});
	});

	it("say it orchestrates when the open asks, as the launcher's Orchestrate does", () => {
		expect(hintsFor({ ...open, quest: QUEST, orchestrate: true })).toEqual({
			questId: QUEST,
			orchestrate: true,
		});
	});

	it("say nothing of orchestrating otherwise, nor of words it wasn't told", () => {
		expect(hintsFor({ ...open, quest: QUEST })).toEqual({ questId: QUEST });
		expect(hintsFor(undefined)).toEqual({});
	});
});
