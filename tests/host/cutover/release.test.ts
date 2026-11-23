import { describe, expect, it } from "vitest";
import {
	chooseReleased,
	type HeldConversation,
	REOPEN_GRACE_MS,
	type ReleaseFacts,
	releaseBack,
	releaseProse,
} from "../../../host/cutover/release.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";

const held = (session: string, kind: "attended" | "background" = "attended") =>
	({ session, host: `work-${kind}`, kind }) satisfies HeldConversation;

const ADDRESSES: Record<string, string[]> = {
	s1: ["AAAAAA", "s1"],
	s2: ["BBBBBB"],
	s3: ["CCCCCC"],
};

/** How one conversation goes: when it closes and what follows. */
interface Closes {
	/** The look after which it has closed. */
	readonly after: number;
	/** What holds it at each look before. */
	readonly holds?: string[];
	/** False when it closes without leaving a note. */
	readonly note?: boolean;
	/** A window viewing it carries it on in plain pi as it leaves. */
	readonly viewed?: boolean;
}

/** A realm whose conversations close after some looks, as each frees up. */
function fakeRealm(
	closes: Record<string, Closes>,
	{
		conversations = Object.keys(closes).map((one) => held(one)),
		launcherTakes = true,
	}: { conversations?: HeldConversation[]; launcherTakes?: boolean } = {},
) {
	let looks = 0;
	let clock = 0;
	const told: string[] = [];
	const woken: string[] = [];
	const reopened: string[] = [];
	const calledOff: string[] = [];
	const journals: { quest: string; prose: string }[] = [];
	const said: string[] = [];
	/** The look at which restore.json was written, each time. */
	const refreshedAt: number[] = [];
	const gone = (session: string) =>
		told.includes(ADDRESSES[session]?.[0] ?? session) &&
		looks > (closes[session]?.after ?? Number.POSITIVE_INFINITY);
	const facts: ReleaseFacts = {
		held: async () => ({
			held: conversations.filter((one) => !gone(one.session)),
			unheard: [],
		}),
		addressesOf: (session) =>
			// Its presence goes once it has closed.
			gone(session) ? [] : (ADDRESSES[session] ?? []),
		tell: (address) => told.push(address),
		wake: (session) => woken.push(session),
		note: (session): MoveNote | undefined =>
			closes[session]?.note === false
				? undefined
				: {
						session,
						sessionFile: `/logs/${session}.jsonl`,
						cwd: "/src",
						to: "pi",
						at: "2026-11-24T19:00:00.000Z",
						addresses: ADDRESSES[session] ?? [],
						...(session === "s3" ? {} : { quest: `Q-${session}` }),
						from: "work-attended",
						pid: 1,
					},
		holds: async (session) => closes[session]?.holds?.[looks - 1],
		takenUp: (session) => gone(session) && closes[session]?.viewed === true,
		reopen: async (note) => {
			reopened.push(note.session);
			return launcherTakes;
		},
		callOff: (address) => calledOff.push(address),
		refreshRestore: () => {
			refreshedAt.push(looks);
		},
		journal: (quest, prose) => {
			journals.push({ quest, prose });
			return true;
		},
		now: () => clock,
		pause: async (ms) => {
			clock += ms;
			looks += 1;
		},
		say: (line) => said.push(line),
	};
	return {
		facts,
		told,
		woken,
		reopened,
		calledOff,
		journals,
		said,
		refreshedAt,
		clock: () => clock,
	};
}

describe("chooseReleased", () => {
	it("picks by address in any case or by session id, and names what no host holds", () => {
		const all = [held("s1"), held("s2"), held("s3")];
		const { chosen, unknown } = chooseReleased(
			all,
			(session) => ADDRESSES[session] ?? [],
			["aaaaaa", "s2", "AAAAAA", "ZZZZZZ"],
		);
		expect(chosen.map((one) => one.session)).toEqual(["s1", "s2"]);
		expect(unknown).toEqual(["ZZZZZZ"]);
		expect(
			chooseReleased(all, () => [], "all").chosen.map((one) => one.session),
		).toEqual(["s1", "s2", "s3"]);
	});
});

describe("releaseBack", () => {
	it("tells each to move back, waits for each to close, reopens them and journals what the host held", async () => {
		const realm = fakeRealm({
			s1: { after: 0 },
			s2: {
				after: 2,
				holds: ["a run is under way", "background jobs are out"],
			},
		});
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(realm.told).toEqual(["AAAAAA", "BBBBBB"]);
		expect(
			report.released.map(({ address, opened }) => ({ address, opened })),
		).toEqual([
			{ address: "AAAAAA", opened: "launcher" },
			{ address: "BBBBBB", opened: "launcher" },
		]);
		expect(report.waiting).toEqual([]);
		expect(realm.journals).toEqual([
			{
				quest: "Q-s1",
				prose:
					"AAAAAA was released from the work-attended host back to plain pi at 2026-11-24T19:00:00.000Z, and the launcher reopened it in plain pi from the same file, as Reopen Them All does. It closed at once, holding nothing. Only the host held its screen, so any viewer closed with it.",
			},
			{
				quest: "Q-s2",
				prose: expect.stringContaining(
					"Before it closed it waited while a run is under way; then while background jobs are out.",
				),
			},
		]);
	});

	// On 15 November a drill released ten, and the six that left at once
	// waited off the mesh, with no pi, until the release ended: QQ1UAK
	// was mid-merge (OSPHT4 [e8c33ae1]).
	it("reopens each as it leaves, not once the last has", async () => {
		const realm = fakeRealm({ s1: { after: 0 }, s2: { after: 40 } });
		const reopenedAt: number[] = [];
		const reopen = realm.facts.reopen;
		realm.facts.reopen = async (note) => {
			reopenedAt.push(realm.clock());
			return reopen(note);
		};

		await releaseBack("all", realm.facts, 600_000);

		expect(realm.reopened).toEqual(["s1", "s2"]);
		expect(
			reopenedAt[0],
			"the first reopened once the grace after it left passed",
		).toBeLessThanOrEqual(REOPEN_GRACE_MS + 2 * 2_000);
		expect(
			realm.refreshedAt[0],
			"Sessions to Reopen offers it the look it left",
		).toBe(1);
	});

	it("leaves one a window viewing it carried on, rather than open it twice", async () => {
		const realm = fakeRealm({ s1: { after: 0, viewed: true } });
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(realm.reopened, "nothing opened beside the window").toEqual([]);
		expect(report.released).toMatchObject([
			{ address: "AAAAAA", opened: "window" },
		]);
		expect(realm.journals[0]?.prose).toContain(
			"and carried on in plain pi in the window viewing it, from the same file.",
		);
	});

	it("offers one the launcher wouldn't take in Sessions to Reopen", async () => {
		const realm = fakeRealm({ s1: { after: 0 } }, { launcherTakes: false });
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(report.released).toMatchObject([
			{ address: "AAAAAA", opened: "offered" },
		]);
		expect(realm.journals[0]?.prose).toContain(
			"and waits in the launcher's Sessions to Reopen to open from the same file.",
		);
	});

	it("only offers each when asked not to reopen them", async () => {
		const realm = fakeRealm({ s1: { after: 0 } });
		const report = await releaseBack("all", realm.facts, 60_000, {
			reopen: false,
		});

		expect(realm.reopened).toEqual([]);
		expect(report.released).toMatchObject([{ opened: "offered" }]);
	});

	it("calls off the move of one still held at the deadline, saying what holds it", async () => {
		const realm = fakeRealm({
			s1: { after: 99, holds: new Array(99).fill("a prompt is open") },
		});
		const report = await releaseBack(["AAAAAA"], realm.facts, 6_000);

		expect(report.released).toEqual([]);
		expect(report.waiting).toEqual([
			{ address: "AAAAAA", holds: "a prompt is open" },
		]);
		expect(realm.calledOff, "so it never leaves later unopened").toEqual([
			"AAAAAA",
		]);
		expect(
			realm.said.filter((line) => line.includes("waits")),
			"said once while it holds the same",
		).toEqual(["AAAAAA waits: a prompt is open"]);
	});

	it("stops when told to, calling off every move still waiting", async () => {
		const realm = fakeRealm({ s1: { after: 0 }, s2: { after: 99 } });
		const stop = new AbortController();
		const pause = realm.facts.pause;
		realm.facts.pause = async (ms) => {
			await pause(ms);
			if (realm.clock() >= 20_000) stop.abort();
		};

		const report = await releaseBack("all", realm.facts, 600_000, {
			stop: stop.signal,
		});

		expect(realm.clock(), "long before its deadline").toBeLessThan(60_000);
		expect(realm.calledOff).toEqual(["BBBBBB"]);
		expect(report.released.map((one) => one.address)).toEqual(["AAAAAA"]);
		expect(report.waiting.map((one) => one.address)).toEqual(["BBBBBB"]);
	});

	it("names one gone without a note or a pi as lost, and one without a quest as not journaled", async () => {
		const realm = fakeRealm({
			s1: { after: 0, note: false },
			s3: { after: 0 },
		});
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(report.lost).toEqual(["AAAAAA"]);
		expect(report.released).toMatchObject([
			{ address: "CCCCCC", journaled: false },
		]);
		expect(realm.journals).toEqual([]);
	});

	it("counts one whose window took it up, its note settled, as released", async () => {
		const realm = fakeRealm({ s1: { after: 0, note: false, viewed: true } });
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(report.lost).toEqual([]);
		expect(report.released).toMatchObject([
			{ address: "AAAAAA", opened: "window" },
		]);
	});

	it("tells nobody it wasn't asked to", async () => {
		const realm = fakeRealm({ s1: { after: 0 }, s2: { after: 0 } });
		const report = await releaseBack(["s2"], realm.facts, 60_000);

		expect(realm.told).toEqual(["BBBBBB"]);
		expect(report.released.map((one) => one.session)).toEqual(["s2"]);
	});

	it("wakes each it tells, so one parked takes the move it was told", async () => {
		const realm = fakeRealm({ s1: { after: 0 }, s2: { after: 0 } });
		await releaseBack("all", realm.facts, 60_000);

		expect(realm.woken, "each told one is woken, by session").toEqual([
			"s1",
			"s2",
		]);
	});

	// On 23 November E30 failed once under load: a release said its one
	// conversation "closed without a note" while its run went on, since a
	// host too loaded to answer its list read as holding nothing
	// (2QZBX9 [c498fc60]).
	it("passes over looks its host didn't answer for longer than the grace, rather than read it as gone", async () => {
		const realm = leavesAfter(20);
		// Looks 2 to 11, the first ten after it is told, go unheard: 20 s
		// of looks, past the grace.
		const unheard = (look: number) => look >= 2 && look <= 11;
		realm.facts.held = unheardFor(realm, unheard);
		const report = await releaseBack("all", realm.facts, 120_000);

		expect(report.lost, realm.said.join("\n")).toEqual([]);
		expect(report.released).toMatchObject([
			{ address: "AAAAAA", opened: "launcher" },
		]);
		expect(
			realm.refreshedAt,
			"restore.json is written only as it really leaves, and at the end",
		).toEqual([21, 29]);
		expect(
			realm.said.filter((line) => line.includes("looking again")),
			"said once while the reason holds, under a minute",
		).toEqual([`looking again: ${UNHEARD}`]);
		expect(report.unheard).toBeUndefined();
	});

	it("reads only the unheard host's conversations as unknown, seeing the other host's leave", async () => {
		const realm = fakeRealm(
			{ s1: { after: 1000, note: false }, s2: { after: 0 } },
			{ conversations: [held("s1"), held("s2", "background")] },
		);
		// The attended host goes unheard from the third look after the tell.
		realm.facts.held = unheardFor(realm, (look) => look >= 4);
		const report = await releaseBack("all", realm.facts, 40_000);

		expect(report.released.map((one) => one.address)).toEqual(["BBBBBB"]);
		expect(report.lost, "never read as gone").toEqual([]);
		expect(
			realm.refreshedAt,
			"written as the background one left, and at the end",
		).toEqual([1, 20]);
		expect(realm.calledOff, "it never left, so it stays hosted").toEqual([
			"AAAAAA",
		]);
	});

	it("settles as left for pi, not called off, one whose host stays unheard to the deadline and whose note says it left", async () => {
		const realm = fakeRealm({ s1: { after: 3 } });
		// Heard as it is told, then unheard to the end.
		realm.facts.held = unheardFor(realm, (look) => look >= 2);
		const report = await releaseBack("all", realm.facts, 10_000);

		expect(realm.calledOff, realm.said.join("\n")).toEqual([]);
		expect(report.waiting).toEqual([]);
		expect(report.released).toMatchObject([
			{ address: "AAAAAA", opened: "launcher" },
		]);
		expect(report.unheard).toBe(UNHEARD);
	});

	it("looks again until the first look hears every host, then tells only what it found", async () => {
		const realm = fakeRealm({ s1: { after: 0 } });
		realm.facts.held = unheardFor(realm, (look) => look <= 2);
		const report = await releaseBack("all", realm.facts, 60_000);

		expect(realm.told).toEqual(["AAAAAA"]);
		expect(report.released.map((one) => one.address)).toEqual(["AAAAAA"]);
		expect(realm.said[0]).toBe(`looking again: ${UNHEARD}`);
	});

	it("tells nobody when no first look hears every host before the deadline", async () => {
		const realm = fakeRealm({ s1: { after: 0 } });
		const held = realm.facts.held;
		realm.facts.held = async () => {
			await held();
			throw new Error("Host control request timed out; outcome unknown");
		};
		const report = await releaseBack(["AAAAAA"], realm.facts, 6_000);

		expect(realm.told).toEqual([]);
		expect(report.unknown).toEqual(["AAAAAA"]);
		expect(report.unheard).toBe(
			"Host control request timed out; outcome unknown",
		);
	});

	it("tells none of all a heard host holds while the other stays unheard", async () => {
		const realm = fakeRealm(
			{ s1: { after: 0 }, s2: { after: 0 } },
			{ conversations: [held("s1"), held("s2", "background")] },
		);
		realm.facts.held = unheardFor(realm, () => true);
		const report = await releaseBack("all", realm.facts, 6_000);

		expect(realm.told, "half a list never chooses who goes").toEqual([]);
		expect(report.released).toEqual([]);
		expect(report.unheard).toBe(UNHEARD);
	});

	it("says again once a minute that a host stays unheard", async () => {
		const realm = leavesAfter(70);
		realm.facts.held = unheardFor(realm, (look) => look >= 1 && look <= 65);
		await releaseBack("all", realm.facts, 300_000);

		expect(realm.said.filter((line) => line.includes("looking again"))).toEqual(
			[
				`looking again: ${UNHEARD}`,
				`still looking again: ${UNHEARD}`,
				`still looking again: ${UNHEARD}`,
			],
		);
	});

	// A look that misses one, then a look that times out, as a loaded
	// host gives: the grace must not run out across the unheard look.
	it("waits its grace from the next heard look for one a look missed before an unheard one", async () => {
		const realm = leavesAfter(20);
		const held = realm.facts.held;
		let looks = 0;
		realm.facts.held = async () => {
			looks += 1;
			if (looks === 2) return { held: [], unheard: [] };
			if (looks === 3) {
				// A request that timed out took 30 s.
				await realm.facts.pause(30_000);
				return { held: [], unheard: [{ kind: "attended", why: UNHEARD }] };
			}
			return held();
		};
		const report = await releaseBack("all", realm.facts, 300_000);

		expect(report.lost, realm.said.join("\n")).toEqual([]);
		expect(realm.reopened, "opened once, after it left").toEqual(["s1"]);
	});

	it("names one that never leaves a note as lost once the grace is out, even offering only", async () => {
		const realm = fakeRealm({ s1: { after: 0, note: false } });
		const report = await releaseBack("all", realm.facts, 60_000, {
			reopen: false,
		});

		expect(report.lost).toEqual(["AAAAAA"]);
		expect(realm.clock()).toBeGreaterThanOrEqual(REOPEN_GRACE_MS);
	});

	it("waits again on one a look missed and the next found held", async () => {
		const realm = leavesAfter(12);
		const held = realm.facts.held;
		let looks = 0;
		realm.facts.held = async () => {
			looks += 1;
			return looks === 2 ? { held: [], unheard: [] } : held();
		};
		const report = await releaseBack("all", realm.facts, 120_000);

		expect(report.lost, realm.said.join("\n")).toEqual([]);
		expect(report.released).toMatchObject([
			{ address: "AAAAAA", opened: "launcher" },
		]);
		expect(realm.reopened, "opened once, after it left").toEqual(["s1"]);
	});

	it("waits out the grace for the note of one that left without one yet, even offering only", async () => {
		const realm = leavesAfter(0);
		const note = realm.facts.note;
		const started = realm.clock();
		realm.facts.note = (session) =>
			realm.clock() - started >= 4_000 ? note(session) : undefined;
		const report = await releaseBack("all", realm.facts, 60_000, {
			reopen: false,
		});

		expect(report.lost, realm.said.join("\n")).toEqual([]);
		expect(report.released).toMatchObject([{ opened: "offered" }]);
	});
});

/** Why the attended host went unheard, in the tests. */
const UNHEARD =
	"the attended host didn't say what it holds: Host control request timed out; outcome unknown";

/**
 * The realm's looks, the attended host unheard on each look `unheard`
 * picks, counting from 1; the background host still answers.
 */
function unheardFor(
	realm: ReturnType<typeof fakeRealm>,
	unheard: (look: number) => boolean,
): ReleaseFacts["held"] {
	const held = realm.facts.held;
	let looks = 0;
	return async () => {
		looks += 1;
		const look = await held();
		if (!unheard(looks)) return look;
		return {
			held: look.held.filter((one) => one.kind !== "attended"),
			unheard: [{ kind: "attended", why: UNHEARD }],
		};
	};
}

/**
 * A realm whose one conversation runs on past `looks` looks and then
 * closes, its note written only as it goes, as a hosted one's is.
 */
function leavesAfter(looks: number) {
	const realm = fakeRealm({
		s1: { after: looks, holds: new Array(looks).fill("a run is under way") },
	});
	const note = realm.facts.note;
	realm.facts.note = (session) =>
		realm.facts.addressesOf(session).length === 0 ? note(session) : undefined;
	return realm;
}

describe("releaseProse", () => {
	it("says where it went, how to open it and what closed with the host", () => {
		expect(
			releaseProse({
				address: "AAAAAA",
				session: "s1",
				from: "work-background",
				at: "2026-11-24T19:00:00.000Z",
				waitedFor: ["messages wait for it"],
				opened: "offered",
			}),
		).toBe(
			"AAAAAA was released from the work-background host back to plain pi at 2026-11-24T19:00:00.000Z, and waits in the launcher's Sessions to Reopen to open from the same file. Before it closed it waited while messages wait for it. Only the host held its screen, so any viewer closed with it.",
		);
	});

	it("says a window it carried on in kept it", () => {
		expect(
			releaseProse({
				address: "AAAAAA",
				session: "s1",
				from: "work-attended",
				at: "2026-11-24T19:00:00.000Z",
				waitedFor: [],
				opened: "window",
			}),
		).toContain("so any other viewer closed with it.");
	});
});
