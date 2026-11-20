/**
 * A carry an orchestrator orders: taken only when nothing of the
 * session's own would be lost, refused with its reason otherwise, and
 * never read as the person's carry (ISXEG8's conditions 3 and 4).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createOrderedCarrying,
	leasesHolding,
	type OrderedCarry,
	type OrderedCarrying,
} from "../../../extensions/mesh-workflow/ordered-carry.ts";
import { isAutomatedText } from "../../../lib/internal/automated.ts";
import { createBoard } from "../../../lib/mesh/lease.ts";

const ORDER: OrderedCarry = {
	to: "penelope",
	why: "its camera work needs the Mac",
	by: "WCJQSG",
};

interface Session {
	idle: boolean;
	/** What holds it besides a run, as each look finds it. */
	holding: (runEnded: boolean) => string | undefined;
	readonly ordering: OrderedCarrying;
	readonly did: string[];
	readonly told: string[];
	readonly refused: string[];
	readonly said: string[];
}

/** A session as an ordered carry sees it, on a clock its looks move. */
function session(
	over: {
		idle?: boolean;
		holding?: (runEnded: boolean) => string | undefined;
		carry?: () => Promise<void>;
		waitMs?: number;
	} = {},
): Session {
	const did: string[] = [];
	const told: string[] = [];
	const refused: string[] = [];
	const said: string[] = [];
	let now = 0;
	const at: Session = {
		idle: over.idle ?? true,
		holding: over.holding ?? (() => undefined),
		did,
		told,
		refused,
		said,
		ordering: createOrderedCarrying({
			idle: () => at.idle,
			abort: () => did.push("abort"),
			holds: async (runEnded) => at.holding(runEnded),
			carry: async (to) => {
				did.push(`carry to ${to}`);
				await (over.carry ?? (async () => {}))();
			},
			refuse: async (why) => {
				refused.push(why);
			},
			tell: (text) => told.push(text),
			close: (by) => did.push(`close: ${by}`),
			carryOn: (text) => said.push(text),
			waitMs: over.waitMs ?? 10_000,
			lookMs: 1_000,
			now: () => now,
			// A look waits a whole turn of the event loop, as a timer does, so
			// what a test does between awaits lands before the next look.
			sleep: async (ms) => {
				now += ms;
				await new Promise((done) => setImmediate(done));
			},
		}),
	};
	return at;
}

describe("an ordered carry", () => {
	it("carries an idle session that holds nothing, then closes it, saying who ordered it and why", async () => {
		const one = session();

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([]);
		expect(one.did).toEqual([
			"carry to penelope",
			"close: an ordered carry to penelope by WCJQSG, for its camera work needs the Mac",
		]);
		expect(one.told.join("\n")).toContain(
			"Carried to penelope, as WCJQSG ordered for its camera work needs the Mac",
		);
	});

	it("refuses at once, saying why, when something of its own is out, and works on", async () => {
		const one = session({
			idle: false,
			holding: () => "a work job is out (j3: push in the held tree)",
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([
			"a work job is out (j3: push in the held tree)",
		]);
		expect(one.did, "its run goes on untouched").toEqual([]);
		expect(one.told.join("\n")).toContain(
			"refused an ordered carry to penelope by WCJQSG: a work job is out",
		);
		one.ordering.started();
		one.ordering.turnEnded();
		expect(one.did, "and nothing holds its runs off after").toEqual([]);
	});

	it("lets the turn under way end, holding off new runs, then carries", async () => {
		const one = session({ idle: false });
		const ordering = one.ordering.order(ORDER);
		await Promise.resolve();

		one.ordering.started();
		expect(one.did, "a run started meanwhile is ended").toEqual(["abort"]);
		one.ordering.turnEnded();
		one.idle = true;
		await ordering;

		expect(one.did).toEqual([
			"abort",
			"abort",
			"carry to penelope",
			expect.stringMatching(/^close: /),
		]);
	});

	it("looks again once its run has ended, and refuses, carrying on, if something holds then", async () => {
		const one = session({
			idle: false,
			holding: (runEnded) =>
				runEnded ? "it holds a lease (hold on the deploy)" : undefined,
		});
		const ordering = one.ordering.order(ORDER);
		await Promise.resolve();
		one.ordering.turnEnded();
		one.idle = true;
		await ordering;

		expect(one.refused).toEqual(["it holds a lease (hold on the deploy)"]);
		expect(one.did).toEqual(["abort"]);
		expect(one.said, "the run it ended is taken up again").toHaveLength(1);
		expect(one.said[0]).toContain("carry on where you left off");
		expect(
			isAutomatedText(one.said[0] ?? ""),
			"its words say they are the harness's, not the person's",
		).toBe(true);
		one.ordering.started();
		expect(one.did, "runs go on after").toEqual(["abort"]);
	});

	it("refuses when its run doesn't end in time, leaving it to work on", async () => {
		const one = session({ idle: false, waitMs: 5_000 });

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual(["its run didn't end within 5 s"]);
		expect(one.said, "no run was ended, so none is taken up").toEqual([]);
	});

	it("refuses with why its carry failed, staying open and carrying on", async () => {
		const one = session({
			carry: async () => {
				throw new Error("no quest is loaded");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([
			"its work couldn't be carried: no quest is loaded",
		]);
		expect(one.did).toEqual(["carry to penelope"]);
	});

	it("says a second order on screen alone, so the first carries with no refusal left", async () => {
		const one = session({ idle: false });
		const first = one.ordering.order(ORDER);
		await one.ordering.order({ ...ORDER, by: "WM4KSZ" });
		one.ordering.turnEnded();
		one.idle = true;
		await first;

		expect(
			one.refused,
			"a refusal written now would read as the live carry's to the node",
		).toEqual([]);
		expect(one.told.join("\n")).toContain(
			"An ordered carry to penelope by WM4KSZ came while a carry is under way",
		);
		expect(one.did).toEqual([
			"abort",
			"carry to penelope",
			"close: an ordered carry to penelope by WCJQSG, for its camera work needs the Mac",
		]);
	});
});

describe("the leases that keep a session from being carried", () => {
	const board = () => createBoard(mkdtempSync(join(tmpdir(), "leases-")));
	const lease = (kind: "change" | "hold" | "heavy", subject: string) => ({
		kind,
		subject,
		since: "2026-11-15T15:00:00.000Z",
		until: "2026-11-15T17:00:00.000Z",
	});
	const now = Date.parse("2026-11-15T16:00:00.000Z");

	it("names each current lease it or its hands hold, leaving a run's own until the run has ended", () => {
		const held = board();
		held.hold({
			session: "s-1",
			leases: [lease("change", "/src/a.ts"), lease("hold", "the deploy")],
		});
		held.hold({
			session: "s-hand",
			handOf: "s-1",
			leases: [lease("heavy", "nix-build")],
		});
		held.hold({ session: "s-2", leases: [lease("hold", "not ours")] });

		expect(leasesHolding(held, "s-1", false, now)).toBe(
			"it holds 2 leases (hold on the deploy; heavy on nix-build)",
		);
		expect(leasesHolding(held, "s-1", true, now)).toBe(
			"it holds 3 leases (change on /src/a.ts; hold on the deploy; heavy on nix-build)",
		);
		expect(leasesHolding(held, "s-2", true, now)).toBe(
			"it holds a lease (hold on not ours)",
		);
		expect(leasesHolding(held, "s-3", true, now)).toBeUndefined();
	});

	it("passes over a lease that has lapsed", () => {
		const held = board();
		held.hold({ session: "s-1", leases: [lease("hold", "the deploy")] });

		expect(
			leasesHolding(held, "s-1", true, Date.parse("2026-11-15T18:00:00.000Z")),
		).toBeUndefined();
	});
});
