/**
 * What a hosted conversation's process keeps of its holding as it ends,
 * and how its next start there reads it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTARTED_WITHIN_MS } from "../../../lib/mesh/address.ts";
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

		expect(keptMap()?.get("never-held")).toBeUndefined();
	});

	it("drops, at each keep, what ended longer ago than a restart", () => {
		const later = (ms: number) => new Date(endedAt + ms).toISOString();
		keepHolding(signing("long-gone", heldFrom), ended);
		keepHolding(signing("lately-gone", heldFrom), later(5 * 60_000));

		keepHolding(signing("now-gone", heldFrom), later(RESTARTED_WITHIN_MS + 1));

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

	it("takes its own over the one it rolled from, though that one ended later", () => {
		const earlier = new Date(endedAt - 60_000).toISOString();
		keepHolding(signing("own-kept", heldFrom), earlier);
		keepHolding(signing("own-kept-from", "2026-11-25T20:00:00.000Z"), ended);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "own-kept", previous: "own-kept-from" },
				endedAt + 30_000,
			),
		).toEqual(kept);
	});

	it("takes its own over the one it rolled from, where its own ended later", () => {
		const earlier = new Date(endedAt - 60_000).toISOString();
		keepHolding(signing("own-later", heldFrom), ended);
		keepHolding(signing("own-later-from", "2026-11-25T20:00:00.000Z"), earlier);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "own-later", previous: "own-later-from" },
				endedAt + 30_000,
			),
		).toEqual(kept);
	});

	it("takes the one it rolled from where its own is past the bound", () => {
		// Its own ended a minute sooner, so a start just past its bound is
		// still within the other's.
		const sooner = endedAt - 60_000;
		keepHolding(
			signing("own-stale", "2026-11-25T19:00:00.000Z"),
			new Date(sooner).toISOString(),
		);
		keepHolding(signing("own-stale-from", heldFrom), ended);

		expect(
			takeHeldAtStart(
				undefined,
				{ session: "own-stale", previous: "own-stale-from" },
				sooner + RESTARTED_WITHIN_MS + 30_000,
			),
		).toEqual(kept);
	});

	it("drops, at each keep, what ended a restart ahead of it, as after a clock set back", () => {
		keepHolding(
			signing("ahead", heldFrom),
			new Date(endedAt + 3_600_000).toISOString(),
		);

		keepHolding(signing("now", heldFrom), ended);

		expect([...(keptMap()?.keys() ?? [])]).toEqual(["now"]);
	});

	it("keeps what it kept through a reload, which loads every module afresh", async () => {
		keepHolding(signing("reloads", heldFrom), ended);
		vi.resetModules();

		const fresh = await import("../../../lib/mesh/kept-holding.ts");

		expect(
			fresh.takeHeldAtStart(
				undefined,
				{ session: "reloads" },
				endedAt + 30_000,
			),
		).toEqual(kept);
	});
});
