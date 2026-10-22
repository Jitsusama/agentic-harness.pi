import { describe, expect, it } from "vitest";
import type { Presence } from "../../../lib/mesh/presence.ts";
import {
	isStopped,
	type Stop,
	stoppedBy,
	stopsFrom,
} from "../../../lib/mesh/stop.ts";

function presence(
	session: string,
	addresses: string[],
	stops?: Stop[],
): Presence {
	return {
		session,
		addresses,
		groups: [],
		worksOn: "",
		owns: [],
		busy: false,
		at: "",
		...(stops ? { stops } : {}),
	};
}

const at = "2026-10-22T04:30:00.000Z";

describe("stopsFrom", () => {
	it("keeps each stop that reads, and only its own fields", () => {
		expect(
			stopsFrom([
				{ address: "P9R1KI", at, session: "s-p", why: "too much", x: 1 },
				{ address: "WCJQSG", at },
				{ address: 7, at },
				{ address: "OVAE1I" },
				"P9R1KI",
			]),
		).toEqual([
			{ address: "P9R1KI", at, session: "s-p", why: "too much" },
			{ address: "WCJQSG", at },
		]);
	});

	it("finds none in what is not a list", () => {
		expect(stopsFrom({ address: "P9R1KI", at })).toEqual([]);
	});
});

describe("isStopped", () => {
	const stops: Stop[] = [{ address: "P9R1KI", session: "s-p", at }];

	it("is true of the address the stop names", () => {
		expect(isStopped({ from: "P9R1KI" }, stops, [])).toBe(true);
	});

	it("follows the stopped session to an address it took up since", () => {
		const everyone = [presence("s-p", ["ZZ9PLZ", "P9R1KI"])];

		expect(isStopped({ from: "ZZ9PLZ" }, stops, everyone)).toBe(true);
	});

	it("is false of anyone else, even under an address others wear", () => {
		const everyone = [presence("s-w", ["WCJQSG"])];

		expect(isStopped({ from: "WCJQSG" }, stops, everyone)).toBe(false);
		expect(
			isStopped({ from: "WCJQSG" }, [{ address: "P9R1KI", at }], everyone),
		).toBe(false);
	});
});

describe("stoppedBy", () => {
	it("names each other peer whose stops hold this one, by address or session", () => {
		const me = presence("s-me", ["7M6JKG", "AFA624B0"]);
		const byAddress = presence(
			"s-p",
			["P9R1KI"],
			[{ address: "AFA624B0", at, why: "too much" }],
		);
		const bySession = presence(
			"s-w",
			["WCJQSG"],
			[{ address: "OLDADDR", session: "s-me", at }],
		);
		const neither = presence("s-o", ["OVAE1I"], [{ address: "2HN63P", at }]);

		expect(
			stoppedBy(me, [me, byAddress, bySession, neither]).map(
				({ stopper, stop }) => [stopper.session, stop.address],
			),
		).toEqual([
			["s-p", "AFA624B0"],
			["s-w", "OLDADDR"],
		]);
	});

	it("never counts a peer's own stops on itself", () => {
		const me = presence("s-me", ["7M6JKG"], [{ address: "7M6JKG", at }]);

		expect(stoppedBy(me, [me])).toEqual([]);
	});
});
