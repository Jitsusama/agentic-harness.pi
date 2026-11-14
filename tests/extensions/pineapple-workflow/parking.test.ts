import { describe, expect, it } from "vitest";
import {
	createParking,
	RESUMED_TEXT,
} from "../../../extensions/pineapple-workflow/parking.ts";
import type { Parked } from "../../../lib/internal/pineapple/park.ts";
import { type Stop, stopOf } from "../../../lib/internal/pineapple/stops.ts";
import { isPersonText } from "../../../lib/internal/session/driven.ts";

function stop(id: string, reaches: string[], shadow = false): Stop {
	const made = stopOf({ shadow, reaches }, id);
	if (!made) throw new Error("a stop with no resume is made");
	return made;
}

function world(initial: Stop[] = []) {
	const seen = {
		stops: initial,
		idle: true,
		aborts: 0,
		carried: [] as string[],
		notes: [] as string[],
		wouldPark: [] as Parked[],
	};
	const parking = createParking({
		stops: () => seen.stops,
		session: async () => ({
			realm: "work",
			quests: ["QEST-CHILD", "QEST-PARENT"],
			repos: ["example/shop"],
			dirs: ["/work/shop"],
		}),
		idle: () => seen.idle,
		abort: () => {
			seen.aborts += 1;
		},
		carryOn: (text) => seen.carried.push(text),
		notify: (text) => seen.notes.push(text),
		wouldPark: (parked) => seen.wouldPark.push(parked),
	});
	return { seen, parking };
}

const quest = stop("q", ["quest:QEST-PARENT"]);

describe("parking", () => {
	it("lets every run go while no stop stands", async () => {
		const { seen, parking } = world();
		await parking.started();
		await parking.turnEnded();
		await parking.tick();
		expect(seen).toMatchObject({ aborts: 0, carried: [], notes: [] });
	});

	it("ends a run a stop reaches as it starts, and says so once", async () => {
		const { seen, parking } = world([quest]);
		await parking.started();
		await parking.started();
		expect(seen.aborts).toBe(2);
		expect(seen.notes).toHaveLength(1);
		expect(seen.notes[0]).toContain("QEST-PARENT");
	});

	it("ends a run at its turn's end once a stop lands while it goes", async () => {
		const { seen, parking } = world();
		await parking.started();
		seen.stops = [quest];
		await parking.turnEnded();
		expect(seen.aborts).toBe(1);
	});

	it("lets the run Joel typed go, stop or no stop", async () => {
		const { seen, parking } = world([quest]);
		parking.heard(true);
		await parking.started();
		await parking.turnEnded();
		expect(seen.aborts).toBe(0);
		parking.heard(false);
		await parking.started();
		expect(seen.aborts).toBe(1);
	});

	it("parks nobody for a stop on one change", async () => {
		const { seen, parking } = world([stop("pr", ["pr:example/shop#12"])]);
		await parking.started();
		expect(seen.aborts).toBe(0);
	});

	it("parks nobody for a shadow stop, and notes once that it would have", async () => {
		const { seen, parking } = world([stop("q", ["quest:QEST-PARENT"], true)]);
		await parking.started();
		await parking.started();
		expect(seen.aborts).toBe(0);
		expect(seen.wouldPark.map((one) => one.stop.id)).toEqual(["q"]);
	});

	it("carries on once Joel resumes, told to look before it writes", async () => {
		const { seen, parking } = world([quest]);
		await parking.started();
		await parking.tick();
		expect(seen.carried).toEqual([]);
		seen.stops = [];
		seen.idle = false;
		await parking.tick();
		expect(seen.carried).toEqual([]);
		seen.idle = true;
		await parking.tick();
		await parking.tick();
		expect(seen.carried).toEqual([RESUMED_TEXT]);
		expect(RESUMED_TEXT).toContain("check what changed");
	});

	it("says the resume as the harness, so it isn't taken for Joel typing", () => {
		expect(isPersonText(RESUMED_TEXT) ? "person" : "harness").toBe("harness");
	});
});
