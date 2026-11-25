/**
 * What a hosted conversation's process keeps of its holding as it ends,
 * and how its next start there reads it.
 */
import { describe, expect, it } from "vitest";
import { heldAtStart, keepHolding } from "../../../lib/mesh/kept-holding.ts";

const heldFrom = "2026-11-21T20:47:00.000Z";
const endedAt = Date.parse("2026-11-25T21:00:00.000Z");
const ended = new Date(endedAt).toISOString();

function signing(session: string, signsSince?: string) {
	return {
		session,
		addresses: ["7M6JKG"],
		...(signsSince ? { signsSince } : {}),
	};
}

describe("a hosted conversation's holding through its restart", () => {
	it("seeds its next start in the process with the time it held from", () => {
		keepHolding(signing("restarts-in-place", heldFrom), ended);

		expect(
			heldAtStart(undefined, "restarts-in-place", undefined, endedAt + 30_000),
		).toEqual({ address: "7M6JKG", since: heldFrom });
	});

	it("seeds only the next start, so a later one starts afresh", () => {
		keepHolding(signing("starts-twice", heldFrom), ended);
		heldAtStart(undefined, "starts-twice", undefined, endedAt + 30_000);

		expect(
			heldAtStart(undefined, "starts-twice", undefined, endedAt + 60_000),
		).toBeUndefined();
	});

	it("seeds the session it rolled over to, from the one it left", () => {
		keepHolding(signing("rolled-from", heldFrom), ended);

		expect(
			heldAtStart(undefined, "rolled-to", "rolled-from", endedAt + 30_000),
		).toEqual({ address: "7M6JKG", since: heldFrom });
	});

	it("starts afresh when it starts again an hour after it ended", () => {
		keepHolding(signing("back-an-hour-on", heldFrom), ended);

		expect(
			heldAtStart(undefined, "back-an-hour-on", undefined, endedAt + 3_600_000),
		).toBeUndefined();
	});

	it("keeps nothing of a session that said no time", () => {
		keepHolding(signing("never-held"), ended);

		expect(
			heldAtStart(undefined, "never-held", undefined, endedAt + 30_000),
		).toBeUndefined();
	});

	it("reads its own presence first, where that still says a time", () => {
		keepHolding(signing("both-said", "2026-11-25T20:00:00.000Z"), ended);
		const before = {
			addresses: ["7M6JKG"],
			signsSince: heldFrom,
			at: ended,
			state: "parked",
		};

		expect(
			heldAtStart(before, "both-said", undefined, endedAt + 30_000),
		).toEqual({ address: "7M6JKG", since: heldFrom });
	});
});
