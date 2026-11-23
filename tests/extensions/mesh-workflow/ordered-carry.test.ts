/**
 * A carry an orchestrator orders: taken only when nothing of the
 * session's own would be lost, refused with its reason otherwise, and
 * never read as the person's carry (ISXEG8's conditions 3 and 4).
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createOrderedCarrying,
	leasesHolding,
	type OrderedCarry,
	type OrderedCarrying,
	refuseInHandover,
} from "../../../extensions/mesh-workflow/ordered-carry.ts";
import { isAutomatedText } from "../../../lib/internal/automated.ts";
import { handoverOf } from "../../../lib/internal/carry/handover.ts";
import { refusedFileOf } from "../../../lib/internal/carry/ordered.ts";
import { thisMachine } from "../../../lib/internal/machine/machine.ts";
import { sessionRegistryDir } from "../../../lib/internal/quest/sessions/loaded.ts";
import { questWorkspacesRoot } from "../../../lib/internal/quest/workspace/workspace-root.ts";
import { createBoard } from "../../../lib/mesh/lease.ts";

const ORDER: OrderedCarry = {
	to: "penelope",
	why: "its camera work needs the Mac",
	by: "WCJQSG",
};

const HELD = "it holds a lease";

/** Holding `why` at its first look alone, so a later carry carries. */
function once(why: string): () => string | undefined {
	let looked = false;
	return () => {
		if (looked) return undefined;
		looked = true;
		return why;
	};
}

interface Session {
	idle: boolean;
	/** What holds it besides a run, as each look finds it. */
	holding: (runEnded: boolean) => string | undefined;
	readonly ordering: OrderedCarrying;
	readonly did: string[];
	readonly told: string[];
	readonly refused: string[];
	/** When each refusal says it was, as `refused` lists them. */
	readonly refusedAt: Date[];
	/** How many holds on the session's doors are taken and not let go. */
	readonly holdsTaken: () => number;
	readonly said: string[];
}

/** A session as an ordered carry sees it, on a clock its looks move. */
function session(
	over: {
		idle?: boolean;
		holding?: (runEnded: boolean) => string | undefined;
		carry?: () => Promise<void>;
		/** Waited on as each refusal is written. */
		writing?: () => Promise<void>;
		waitMs?: number;
		refuseMs?: number;
		/** Where its clock starts, in ms since the epoch. */
		start?: number;
	} = {},
): Session {
	const did: string[] = [];
	const told: string[] = [];
	const refused: string[] = [];
	const refusedAt: Date[] = [];
	const said: string[] = [];
	let now = over.start ?? 0;
	let holdsTaken = 0;
	const at: Session = {
		holdsTaken: () => holdsTaken,
		idle: over.idle ?? true,
		holding: over.holding ?? (() => undefined),
		did,
		told,
		refused,
		refusedAt,
		said,
		ordering: createOrderedCarrying({
			idle: () => at.idle,
			abort: () => did.push("abort"),
			holds: async (runEnded) => at.holding(runEnded),
			hold: () => {
				holdsTaken += 1;
				let held = true;
				// Let go once, as the registry's hold is.
				return () => {
					if (held) holdsTaken -= 1;
					held = false;
				};
			},
			carry: async (to) => {
				did.push(`carry to ${to}`);
				await (over.carry ?? (async () => {}))();
			},
			refuse: async (why, stamp) => {
				await (over.writing ?? (async () => {}))();
				refused.push(why);
				refusedAt.push(stamp);
			},
			tell: (text) => told.push(text),
			close: (by) => did.push(`close: ${by}`),
			carryOn: (text) => said.push(text),
			waitMs: over.waitMs ?? 10_000,
			lookMs: 1_000,
			...(over.refuseMs === undefined ? {} : { refuseMs: over.refuseMs }),
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

	// ISXEG8's condition 3: a carry this machine's node chose is said as
	// the node's, on screen and in the journal, never as an order.
	it("says a carry its machine's node chose as the node's, in every word it says of one, never as an order", async () => {
		const eased: OrderedCarry = {
			...ORDER,
			by: "node@optimus",
			why: "optimus has stalled",
		};
		const carried = session({ idle: false });
		const refused = session({ holding: () => "it holds a lease" });
		const ended = session({
			idle: false,
			holding: (runEnded) => (runEnded ? "it holds a lease" : undefined),
		});

		const carrying = carried.ordering.order(eased);
		await Promise.resolve();
		await carried.ordering.order(eased);
		carried.ordering.turnEnded();
		carried.idle = true;
		await carrying;
		await refused.ordering.order(eased);
		const ending = ended.ordering.order(eased);
		await Promise.resolve();
		ended.ordering.turnEnded();
		ended.idle = true;
		await ending;

		expect(carried.told).toEqual(
			expect.arrayContaining([
				"The mycelium node on optimus chose to carry this session to penelope, for optimus has stalled: letting the turn under way end first.",
				"A carry to penelope that the mycelium node on optimus chose came while a carry is under way, so it is left to the one under way.",
			]),
		);
		expect(ended.said).toEqual([
			expect.stringContaining(
				"] A carry to penelope that the mycelium node on optimus chose ended this run to go, then couldn't: it holds a lease.",
			),
		]);

		expect(carried.did).toEqual([
			"abort",
			"carry to penelope",
			"close: a carry to penelope that the mycelium node on optimus chose, for optimus has stalled",
		]);
		expect(carried.told.join("\n")).toContain(
			"Carried to penelope, as the mycelium node on optimus chose for optimus has stalled",
		);
		expect(refused.told.join("\n")).toContain(
			"refused a carry to penelope that the mycelium node on optimus chose: it holds a lease",
		);
		for (const one of [carried, refused, ended]) {
			expect([...one.told, ...one.did, ...one.said].join("\n")).not.toMatch(
				/order/i,
			);
		}
	});

	it("says an orchestrator's carry as its order, waiting and ended alike", async () => {
		const order: OrderedCarry = { ...ORDER, by: "WCJQSG", why: "the Mac" };
		const carried = session({ idle: false });
		const ended = session({
			idle: false,
			holding: (runEnded) => (runEnded ? "it holds a lease" : undefined),
		});

		const carrying = carried.ordering.order(order);
		await Promise.resolve();
		carried.ordering.turnEnded();
		carried.idle = true;
		await carrying;
		const ending = ended.ordering.order(order);
		await Promise.resolve();
		ended.ordering.turnEnded();
		ended.idle = true;
		await ending;

		expect(carried.told).toContain(
			"WCJQSG ordered this session carried to penelope, for the Mac: letting the turn under way end first.",
		);
		expect(ended.said).toEqual([
			expect.stringContaining(
				"] An ordered carry to penelope by WCJQSG ended this run to go, then couldn't: it holds a lease.",
			),
		]);
	});

	it("says a carry its take already turned down on screen alone, writing nothing and touching nothing", async () => {
		const one = session({
			idle: false,
			holding: () => {
				throw new Error("nothing of its own is looked at");
			},
		});

		await one.ordering.order({
			...ORDER,
			by: "node@optimus",
			why: "optimus has stalled",
			refused: "whose node's carry it is can't be told",
		});

		expect(one.refused, "nothing written").toEqual([]);
		expect(one.did, "no run ended, nothing carried").toEqual([]);
		expect(one.said).toEqual([]);
		expect(one.told.join("\n")).toContain(
			"This session refused a carry to penelope said to come from the mycelium node on optimus: whose node's carry it is can't be told. It stays here, working.",
		);
	});

	it("carries nothing that comes while a refusal is being written", async () => {
		let written: () => void = () => {};
		const one = session({
			holding: once(HELD),
			writing: () =>
				new Promise<void>((done) => {
					written = done;
				}),
		});
		const refusing = one.ordering.order({
			...ORDER,
			by: "node@optimus",
			why: "optimus has stalled",
		});
		await Promise.resolve();

		await one.ordering.order(ORDER);

		expect(one.did, "nothing carried while the refusal is written").toEqual([]);
		expect(one.told.join("\n")).toContain(
			"An ordered carry to penelope by WCJQSG came while a refusal is being written, so it is left unanswered: its node may read that refusal as this one's, or waits out its time",
		);
		written();
		await refusing;
		expect(one.refused).toEqual([HELD]);

		await one.ordering.order(ORDER);
		expect(one.did, "a carry once the refusal is written").toContain(
			"carry to penelope",
		);
	});

	// Stamped at its steer's millisecond's end, the refusal is older than
	// any carry its node began since, so none need wait for it.
	it("carries what comes while a refusal stamped from its steer's name is being written", async () => {
		const put = Date.parse("2026-11-19T14:00:00.000Z");
		let written: () => void = () => {};
		const one = session({
			start: put + 5_000,
			holding: once(HELD),
			writing: () =>
				new Promise<void>((done) => {
					written = done;
				}),
		});
		const refusing = one.ordering.order({
			...ORDER,
			put: new Date(put),
			by: "node@optimus",
			why: "optimus has stalled",
		});
		await Promise.resolve();

		await one.ordering.order(ORDER);

		expect(one.did, "carried while the refusal is written").toContain(
			"carry to penelope",
		);
		expect(one.told.join("\n")).not.toContain("came while a refusal");
		written();
		await refusing;
		expect(one.refusedAt).toEqual([new Date(put + 1)]);
	});

	// Stamped as it was asked, a refusal is as new as any carry begun
	// since, so one named later than now holds carries back as it is
	// written, as one with no name does.
	it("carries nothing that comes while a refusal of a steer named later than now is being written", async () => {
		let written: () => void = () => {};
		const one = session({
			start: 7_000,
			holding: once(HELD),
			writing: () =>
				new Promise<void>((done) => {
					written = done;
				}),
		});
		const refusing = one.ordering.order({
			...ORDER,
			put: new Date("2286-11-20T17:46:39.999Z"),
			by: "node@optimus",
		});
		await Promise.resolve();

		await one.ordering.order(ORDER);

		expect(one.did, "nothing carried while the refusal is written").toEqual([]);
		written();
		await refusing;
		expect(one.refusedAt).toEqual([new Date(7_000)]);
	});

	// This machine's node reads this machine's handover, and would take a
	// refusal there as its own live carry's; another machine's reads none.
	it("writes no refusal of a carry another machine's node names, saying it on screen", async () => {
		const one = session({ start: 7_000 });
		await one.ordering.order({
			...ORDER,
			put: new Date(5_000),
			by: "node@kestrel",
			refused:
				"it names node@kestrel, but this machine is skiff, so it isn't this machine's node's carry",
		});

		expect(one.refused, "nothing written").toEqual([]);
		expect(one.told.join("\n")).toContain(
			"This session refused a carry to penelope said to come from the mycelium node on kestrel: it names node@kestrel",
		);
		await one.ordering.order(ORDER);
		expect(one.did).toContain("carry to penelope");
	});

	it("carries what comes once a refusal couldn't be written", async () => {
		const one = session({
			holding: once(HELD),
			writing: () => Promise.reject(new Error("the disk is full")),
		});
		await one.ordering.order(ORDER);
		expect(one.told.join("\n")).toContain("the disk is full");

		await one.ordering.order(ORDER);
		expect(one.did).toContain("carry to penelope");
	});

	it("gives up a refusal that never finishes writing, so later carries still carry", async () => {
		const one = session({
			holding: once(HELD),
			writing: () => new Promise<void>(() => {}),
			refuseMs: 10,
		});
		await one.ordering.order(ORDER);
		expect(one.told.join("\n")).toContain(
			"Its refusal wasn't written where mycelium reads it within 0.01 s; it may still land there, or the carry waits out its time there.",
		);

		await one.ordering.order(ORDER);
		expect(one.did).toContain("carry to penelope");
	});

	// Its node counts a refusal no older than the carry it began, so one
	// stamped as its own steer was put, which its node began before, is
	// never read as a carry that began after: written late, or while
	// another carry's steer was being taken.
	it("stamps a refusal at the end of the millisecond its steer was put in the inbox, though asked for seconds later", async () => {
		const put = Date.parse("2026-11-19T14:00:00.000Z");
		const one = session({ start: put + 5_000, holding: once(HELD) });
		await one.ordering.order({ ...ORDER, put: new Date(put) });
		expect(one.refusedAt).toEqual([new Date("2026-11-19T14:00:00.001Z")]);
	});

	it("stamps a refusal as it is asked for when its steer's time can't be told", async () => {
		const one = session({ start: 7_000, holding: once(HELD) });
		await one.ordering.order(ORDER);
		expect(one.refusedAt).toEqual([new Date(7_000)]);
	});

	// Read in the very millisecond it was put, as a watch on the inbox
	// may: its node began it within that millisecond, so the stamp is
	// still its end.
	it("stamps a refusal at its steer's millisecond's end when it is read in that millisecond", async () => {
		const put = Date.parse("2026-11-19T14:00:00.000Z");
		const one = session({ start: put, holding: once(HELD) });
		await one.ordering.order({ ...ORDER, put: new Date(put) });
		expect(one.refusedAt).toEqual([new Date(put + 1)]);
	});

	// No node names a steer ahead of its clock, and a refusal dated ahead
	// would stand over every refusal after it.
	it("stamps a refusal as it is asked for when its steer is named later than now", async () => {
		const one = session({ start: 7_000, holding: once(HELD) });
		await one.ordering.order({
			...ORDER,
			put: new Date("2286-11-20T17:46:39.999Z"),
		});
		expect(one.refusedAt).toEqual([new Date(7_000)]);
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

	// A context gone stale throws as it is read; a look that threw once
	// left its node waiting out its time, refused by nothing.
	it("refuses, saying why, when a look at what holds it throws, and lets go", async () => {
		const one = session({
			holding: () => {
				throw new Error("the context is stale");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([
			"it couldn't be looked at: the context is stale",
		]);
		expect(one.holdsTaken()).toBe(0);
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

	it("takes up the run it ended though its refusal couldn't be written, or wasn't in time", async () => {
		for (const writing of [
			() => Promise.reject(new Error("the disk is full")),
			() => new Promise<void>(() => {}),
		]) {
			const one = session({
				idle: false,
				holding: (runEnded) =>
					runEnded ? "it holds a lease (hold on the deploy)" : undefined,
				writing,
				refuseMs: 10,
			});
			const ordering = one.ordering.order(ORDER);
			await Promise.resolve();
			one.ordering.turnEnded();
			one.idle = true;
			await ordering;

			expect(one.refused, "never written").toEqual([]);
			expect(one.said, "the run it ended is taken up again").toHaveLength(1);
			expect(one.said[0]).toContain("carry on where you left off");
		}
	});

	// No node here began it, so it waits on nothing a live carry, or a
	// refusal being written, holds.
	it("says a carry another machine's node names refused, though a carry is under way", async () => {
		const one = session({ idle: false });
		const ordering = one.ordering.order(ORDER);
		await Promise.resolve();

		await one.ordering.order({
			...ORDER,
			by: "node@kestrel",
			refused: "it names node@kestrel",
		});
		expect(one.told.join("\n")).toContain(
			"This session refused a carry to penelope said to come from the mycelium node on kestrel: it names node@kestrel",
		);
		expect(one.told.join("\n")).not.toContain("left to the one under way");

		one.ordering.turnEnded();
		one.idle = true;
		await ordering;
		expect(one.refused, "nothing written").toEqual([]);
		expect(one.did, "the live carry still goes").toContain("carry to penelope");
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

	// A park in the gap between ending its run and carrying, or while its
	// refusal is written, would end it with nothing written for its node
	// (PV3TE0's F39, 23 November).
	it("holds the session's doors from its order until it is carried", async () => {
		const seen: number[] = [];
		const one = session({
			idle: false,
			holding: () => {
				seen.push(one.holdsTaken());
				return undefined;
			},
			carry: async () => {
				seen.push(one.holdsTaken());
			},
		});
		const going = one.ordering.order(ORDER);
		one.ordering.turnEnded();
		one.idle = true;
		await going;

		expect(seen).toEqual([1, 1, 1]);
		expect(one.holdsTaken()).toBe(0);
	});

	it("lets go of them as it refuses, before its refusal is written, since it carries nothing", async () => {
		const seen: number[] = [];
		const one = session({
			holding: once("a fleet is out"),
			writing: async () => {
				seen.push(one.holdsTaken());
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual(["a fleet is out"]);
		expect(seen).toEqual([0]);
		expect(one.holdsTaken()).toBe(0);
	});

	it("takes no hold for an order it leaves to the carry under way", async () => {
		const one = session({ idle: false });
		const first = one.ordering.order(ORDER);
		const during: number[] = [];
		await one.ordering.order({ ...ORDER, by: "WM4KSZ" });
		during.push(one.holdsTaken());
		one.ordering.turnEnded();
		one.idle = true;
		await first;

		expect(during).toEqual([1]);
		expect(one.holdsTaken()).toBe(0);
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

describe("a refusal written where mycelium reads it", () => {
	it("goes in this machine's handover, as its done file does, stamped as it was asked", async () => {
		const home = mkdtempSync(join(tmpdir(), "refused-"));
		vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
		vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
		try {
			const registry = sessionRegistryDir();
			mkdirSync(registry, { recursive: true });
			writeFileSync(
				join(registry, "s-carried.json"),
				JSON.stringify({
					sessionId: "s-carried",
					instanceId: "instance",
					cwd: "/work",
					openedAt: "2026-11-18T00:00:00.000Z",
					quest: "QEST-20261115-HARBOR",
				}),
			);

			await refuseInHandover(
				"s-carried",
				"it holds a lease",
				new Date("2026-11-19T14:00:00.001Z"),
			);

			const refusal = refusedFileOf(
				handoverOf(
					questWorkspacesRoot(),
					"QEST-20261115-HARBOR",
					thisMachine(),
				),
				"s-carried",
			);
			expect(existsSync(refusal), "where this machine's node reads").toBe(true);
			expect(
				JSON.parse(readFileSync(refusal, "utf8")).at,
				"stamped as it was asked, not as it was written",
			).toBe("2026-11-19T14:00:00.001Z");
		} finally {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		}
	});

	// Its node reads its own folder by the name it recorded, so with that
	// record unread no folder is surely its; the hostname may not be.
	it("goes nowhere while this machine's record of its name can't be read", async () => {
		const home = mkdtempSync(join(tmpdir(), "refused-"));
		vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
		vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
		try {
			const registry = sessionRegistryDir();
			mkdirSync(registry, { recursive: true });
			writeFileSync(
				join(registry, "s-carried.json"),
				JSON.stringify({
					sessionId: "s-carried",
					instanceId: "instance",
					cwd: "/work",
					openedAt: "2026-11-18T00:00:00.000Z",
					quest: "QEST-20261115-HARBOR",
				}),
			);
			mkdirSync(join(home, "state/mycelium/machine"), { recursive: true });

			await expect(
				refuseInHandover(
					"s-carried",
					"it holds a lease",
					new Date("2026-11-19T14:00:00.001Z"),
				),
			).rejects.toThrow(
				/^this machine's record of its name, \S*mycelium\/machine, can't be read \(EISDIR\)$/,
			);
			expect(
				existsSync(join(questWorkspacesRoot(), "QEST-20261115-HARBOR")),
				"no handover named by the hostname",
			).toBe(false);
			rmSync(join(home, "state/mycelium/machine"), { recursive: true });
			writeFileSync(join(home, "state/mycelium/machine"), "");
			await expect(
				refuseInHandover(
					"s-carried",
					"it holds a lease",
					new Date("2026-11-19T14:00:00.001Z"),
				),
				"an empty record is said as the record's, not as the carry's",
			).rejects.toThrow(
				/^this machine's record of its name, \S*mycelium\/machine, names no machine$/,
			);
			expect(
				existsSync(join(questWorkspacesRoot(), "QEST-20261115-HARBOR")),
				"the quest's scratch was made though nothing was carried",
			).toBe(false);
		} finally {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
