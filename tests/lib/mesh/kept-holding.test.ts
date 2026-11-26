/**
 * What a hosted conversation's process keeps of its holding as it ends,
 * and how its next start there reads it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	KEPT_KEY,
	type KeptHolding,
	keepHolding,
	takeHeldAtStart,
} from "../../../lib/mesh/kept-holding.ts";

const heldFrom = "2026-11-21T20:47:00.000Z";
const endedAt = Date.parse("2026-11-25T21:00:00.000Z");
const ended = new Date(endedAt).toISOString();
const kept = { address: "7M6JKG", since: heldFrom };

/** The process's map as the module holds it, read for what it keeps. */
function keptMap(): Map<string, KeptHolding> | undefined {
	return (globalThis as { [KEPT_KEY]?: Map<string, KeptHolding> })[KEPT_KEY];
}

afterEach(() => keptMap()?.clear());

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
			takeHeldAtStart(
				undefined,
				{ session: "restarts-in-place" },
				endedAt + 30_000,
			),
		).toEqual(kept);
	});

	it("seeds only the next start, so a later one starts afresh", () => {
		keepHolding(signing("starts-twice", heldFrom), ended);
		takeHeldAtStart(undefined, { session: "starts-twice" }, endedAt + 30_000);

		expect(
			takeHeldAtStart(undefined, { session: "starts-twice" }, endedAt + 60_000),
		).toBeUndefined();
	});

	it("seeds the session it rolled over to, from the one it left", () => {
		keepHolding(signing("rolled-from", heldFrom), ended);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "rolled-to", previous: "rolled-from" },
				endedAt + 30_000,
			),
		).toEqual(kept);
	});

	it("starts afresh when it starts again an hour after it ended", () => {
		keepHolding(signing("back-an-hour-on", heldFrom), ended);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "back-an-hour-on" },
				endedAt + 3_600_000,
			),
		).toBeUndefined();
	});

	it("starts afresh when it rolls over an hour after the one it left ended", () => {
		keepHolding(signing("rolled-late-from", heldFrom), ended);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "rolled-late-to", previous: "rolled-late-from" },
				endedAt + 3_600_000,
			),
		).toBeUndefined();
	});

	it("keeps nothing of a session that said no time", () => {
		keepHolding(signing("never-held"), ended);

		expect(keptMap()?.has("never-held")).toBe(false);
	});

	it("drops, at each keep, what ended longer ago than a restart", () => {
		const later = (ms: number) => new Date(endedAt + ms).toISOString();
		keepHolding(signing("long-gone", heldFrom), ended);
		keepHolding(signing("lately-gone", heldFrom), later(55 * 60_000));

		keepHolding(signing("now-gone", heldFrom), later(3_600_000));

		expect([...(keptMap()?.keys() ?? [])]).toEqual(["lately-gone", "now-gone"]);
	});

	it("reads its own presence first, where that still says a time, and takes both kept", () => {
		keepHolding(signing("both-said", "2026-11-25T20:00:00.000Z"), ended);
		keepHolding(signing("both-said-from", "2026-11-25T20:00:00.000Z"), ended);
		const before = {
			addresses: ["7M6JKG"],
			signsSince: heldFrom,
			at: ended,
		};

		expect(
			takeHeldAtStart(
				before,
				{ session: "both-said", previous: "both-said-from" },
				endedAt + 30_000,
			),
		).toEqual(kept);
		expect(keptMap()?.size, "neither seeds a later start").toBe(0);
	});

	it("keeps no time where its presence stands saying none, as one that yielded since", () => {
		keepHolding(signing("yielded-since", heldFrom), ended);

		expect(
			takeHeldAtStart(
				{ addresses: ["AAAAAAAA"], at: ended },
				{ session: "yielded-since" },
				endedAt + 30_000,
			),
		).toBeUndefined();
	});

	it("takes the later of its own and the one it rolled from, where both kept", () => {
		const earlier = new Date(endedAt - 60_000).toISOString();
		keepHolding(signing("both-kept", "2026-11-25T20:00:00.000Z"), earlier);
		keepHolding(signing("both-kept-from", heldFrom), ended);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "both-kept", previous: "both-kept-from" },
				endedAt + 30_000,
			),
		).toEqual(kept);
	});
});
