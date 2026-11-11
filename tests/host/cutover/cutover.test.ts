/**
 * The cutover on a fake machine: where each live pi goes and why, and
 * carrying the moves out as each session ends itself and is adopted.
 */
import { describe, expect, it } from "vitest";
import { NO_OVERRIDES } from "../../../host/cutover/attended.ts";
import {
	type CutoverFacts,
	carryOut,
	goesBy,
	type MoveFacts,
	type MoveStep,
	planCutover,
	stepLine,
} from "../../../host/cutover/cutover.ts";
import type { WindowStanding } from "../../../host/cutover/windows.ts";
import type { HostKind } from "../../../host/service/address.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

const presence = (session: string, over: Partial<Presence> = {}): Presence => ({
	session,
	addresses: [session.toUpperCase()],
	groups: [],
	worksOn: "",
	owns: [],
	busy: false,
	at: "2026-11-10T09:00:00.000Z",
	owner: { pid: 100, startedAt: 1 },
	...over,
});

const planFacts = (
	present: Presence[],
	over: Partial<CutoverFacts> = {},
): CutoverFacts => ({
	present: async () => present,
	knowsMove: async () => true,
	sessionFile: (session) => `/logs/${session}.jsonl`,
	personWrote: async (file) => file.includes("joel"),
	window: async () => undefined,
	...over,
});

describe("planCutover", () => {
	it("says where every pi goes and why, leaving what isn't to move", async () => {
		const read: string[] = [];
		const steps = await planCutover(
			planFacts(
				[
					presence("joel1", { driven: true }),
					presence("build1", { driven: false }),
					presence("old1", { owner: { pid: 7, startedAt: 1 } }),
					presence("asleep", { state: "parked" }),
					presence("mac1", { machine: "equilibrius" }),
					presence("held1", {
						hosted: { host: "work-attended", conversation: "held1" },
					}),
					presence("me"),
					presence("nolog"),
				],
				{
					self: "me",
					personWrote: async (file) => {
						read.push(file);
						return false;
					},
					knowsMove: async (one) => one.owner?.pid !== 7,
					sessionFile: (session) =>
						session === "nolog" ? undefined : `/logs/${session}.jsonl`,
				},
			),
		);
		expect(steps.map((step) => [step.address, step.kind])).toEqual([
			["JOEL1", "move"],
			["BUILD1", "move"],
			["OLD1", "reload"],
			["ASLEEP", "move"],
			["MAC1", "leave"],
			["ME", "leave"],
			["NOLOG", "leave"],
		]);
		expect(steps.map(stepLine)).toEqual([
			"JOEL1     move to attended            its log holds words a person wrote",
			"BUILD1    move to background          nobody but the harness has written in it",
			"OLD1      reload first                its harness predates the move",
			"ASLEEP    wake and move to background  nobody but the harness has written in it",
			"MAC1      leave                       on equilibrius, left alone",
			"ME        leave                       runs this cutover; move it after",
			"NOLOG     leave                       no saved log to take up",
		]);
		expect(read, "a log read only where no presence says").toEqual([
			"/logs/asleep.jsonl",
		]);
	});

	it("spares a window on Joel's workspace or unplaced, and names an old holder", async () => {
		const windows = new Map<string, WindowStanding>([
			["there", { where: "joel" }],
			["lost", { where: { unplaced: 'niri shows no window titled "x"' } }],
			["away", { where: "away" }],
			["loose", { where: "unheld" }],
			["asleep", { where: "unheld" }],
			[
				"old",
				{
					where: "away",
					loudHolder:
						"its holder (pid 42) runs no mycelium vouched for as carrying #121",
				},
			],
		]);
		const steps = await planCutover(
			planFacts(
				["there", "lost", "away", "loose", "asleep", "old", "bare"].map((one) =>
					presence(one, {
						driven: false,
						...(one === "asleep" ? { state: "parked" as const } : {}),
					}),
				),
				{ window: async ({ session }) => windows.get(session) },
			),
		);
		expect(steps.map(stepLine)).toEqual([
			"THERE     leave                       its window is on the workspace Joel has focused",
			"LOST      leave                       its window can't be placed, so may be Joel's: niri shows no window titled \"x\"",
			"AWAY      move to background          nobody but the harness has written in it",
			"LOOSE     leave                       no mycelium holds it, so whatever window it has would close",
			"ASLEEP    wake and move to background  nobody but the harness has written in it",
			"OLD       move to background          nobody but the harness has written in it; its holder (pid 42) runs no mycelium vouched for as carrying #121, so its window may show a Parked line for 2 to 5 s",
			"BARE      move to background          nobody but the harness has written in it",
		]);
	});

	it("moves a window on Joel's workspace only while he is away, saying so", async () => {
		const windows = new Map<string, WindowStanding>([
			["there", { where: "joel" }],
			["lost", { where: { unplaced: "niri didn't answer" } }],
		]);
		const plan = (joelAway?: () => boolean) =>
			planCutover(
				planFacts(
					["there", "lost"].map((one) => presence(one, { driven: false })),
					{
						window: async ({ session }) => windows.get(session),
						...(joelAway ? { joelAway } : {}),
					},
				),
			);
		expect((await plan(() => true)).map(stepLine)).toEqual([
			"THERE     move to background          nobody but the harness has written in it; its window is on Joel's workspace, and he is away",
			"LOST      leave                       its window can't be placed, so may be Joel's: niri didn't answer",
		]);
		for (const present of [() => false, undefined])
			expect((await plan(present))[0]?.kind, "spared unless he is away").toBe(
				"leave",
			);
	});

	it("puts a session where the person named it", async () => {
		const [step] = await planCutover(
			planFacts([presence("joel1", { driven: true })]),
			{
				attended: new Set(),
				background: new Set(["JOEL1"]),
			},
		);
		expect(step).toMatchObject({ kind: "move", to: "background" });
	});

	it("moves only the sessions named, by address or session id, leaving the rest", async () => {
		const steps = await planCutover(
			planFacts([
				presence("joel1", { driven: true, addresses: ["QUEST1", "JOEL1"] }),
				presence("build1", { driven: false }),
				presence("build2", { driven: false }),
			]),
			NO_OVERRIDES,
			new Set(["JOEL1", "BUILD2"]),
		);
		expect(steps.map(stepLine)).toEqual([
			"QUEST1    move to attended            its log holds words a person wrote",
			"BUILD1    leave                       not named in --only",
			"BUILD2    move to background          nobody but the harness has written in it",
		]);
	});
});

describe("goesBy", () => {
	it("matches a session id or any address, in any case", () => {
		const one = { session: "01ab-cd", addresses: ["QUEST1", "cd0001"] };
		expect(goesBy(one, new Set(["CD0001"])), "a later address").toBe(true);
		expect(goesBy(one, new Set(["01AB-CD"])), "its session id").toBe(true);
		expect(goesBy(one, new Set(["OTHER1"])), "a name it lacks").toBe(false);
	});
});

const note = (session: string, to: HostKind | "pi", pid = 100): MoveNote => ({
	session,
	sessionFile: `/logs/${session}.jsonl`,
	cwd: "/work",
	to,
	at: "2026-11-10T09:00:00.000Z",
	addresses: [session.toUpperCase()],
	pid,
});

const move = (session: string, to: HostKind, parked = false): MoveStep => ({
	kind: "move",
	session,
	address: session.toUpperCase(),
	to,
	why: "",
	parked,
});

/**
 * A machine whose sessions end as the script says: each look, the
 * sessions in `ending` write their note and their pi goes.
 */
function fakeMachine(script: {
	ending: string[][];
	refuse?: (note: MoveNote) => string | undefined;
	holds?: Record<string, string>;
	notes?: MoveNote[];
	/** What the hosts hold at the start, by the host's key. */
	held?: Record<string, string>;
	/** Each look, the sessions the host leaving them lets go. */
	leaving?: string[][];
	/** Sessions whose own window takes the move back before the cutover claims it. */
	takenBack?: string[];
	/** Sessions the target host's roster keeps though its adopt failed. */
	kept?: string[];
	/** Where each session's window stands just before its tell. */
	windows?: Record<string, WindowStanding>;
	/** Whether Joel is away at each ask, in turn; absent, nobody asks. */
	away?: boolean[];
}) {
	const away = script.away === undefined ? undefined : [...script.away];
	const notes = new Map((script.notes ?? []).map((one) => [one.session, one]));
	const claimed = new Map<string, MoveNote>();
	const givenBack: string[] = [];
	const held = new Map(Object.entries(script.held ?? {}));
	const told: string[] = [];
	const woken: string[] = [];
	const adopted: string[] = [];
	const said: string[] = [];
	let looks = 0;
	let clock = 0;
	const goes = new Map<string, HostKind>();
	const facts: MoveFacts = {
		keepPlace: async (session) =>
			session === "b" ? "no window to keep" : "kept",
		windowNow: async (session) => script.windows?.[session],
		...(away === undefined ? {} : { joelAway: () => away.shift() ?? false }),
		tell: (address, to) => {
			told.push(`${address}>${to}`);
			goes.set(address.toLowerCase(), to);
		},
		wake: (session) => woken.push(session),
		notes: () => [...notes.values()],
		removeNote: (session) => {
			notes.delete(session);
			claimed.delete(session);
		},
		claim: (session) => {
			if (script.takenBack?.includes(session)) notes.delete(session);
			const one = notes.get(session);
			if (one === undefined) return undefined;
			notes.delete(session);
			claimed.set(session, one);
			return one;
		},
		kept: async (session) => script.kept?.includes(session) ?? false,
		giveBack: (session) => {
			const one = claimed.get(session);
			if (one === undefined) return;
			claimed.delete(session);
			notes.set(session, one);
			givenBack.push(session);
		},
		// A note from a host runs while that host holds its session.
		running: async (one) =>
			one.from !== undefined
				? held.get(one.session) === one.from
				: one.pid !== 0,
		held: async () => {
			for (const session of script.leaving?.[looks] ?? []) held.delete(session);
			for (const session of script.ending[looks] ?? []) {
				notes.set(session, note(session, goes.get(session) ?? "background", 0));
			}
			looks += 1;
			return held;
		},
		adopt: async (one, to) => {
			const why = script.refuse?.(one);
			if (why) return why;
			adopted.push(`${one.session}>${to}`);
			held.set(one.session, `work-${to}`);
			return undefined;
		},
		holds: async (session) => script.holds?.[session],
		now: () => clock,
		pause: async (ms) => {
			clock += ms;
		},
		say: (line) => said.push(line),
	};
	return { facts, told, woken, adopted, said, notes, claimed, givenBack };
}

describe("carryOut", () => {
	it("tells each session, wakes the parked, and adopts each as its pi goes", async () => {
		const machine = fakeMachine({ ending: [["a"], [], ["b"]] });
		const report = await carryOut(
			[move("a", "attended"), move("b", "background", true)],
			machine.facts,
			60_000,
		);
		expect(machine.told).toEqual(["A>attended", "B>background"]);
		expect(machine.woken).toEqual(["b"]);
		expect(machine.adopted).toEqual(["a>attended", "b>background"]);
		expect(report).toEqual({
			moved: ["A", "B"],
			waiting: [],
			refused: [],
			takenBack: [],
			places: [
				{ address: "A", said: "kept" },
				{ address: "B", said: "no window to keep" },
			],
			spared: [],
		});
		expect(machine.said.slice(0, 2), "the place kept before the steer").toEqual(
			["A's window: kept", "told A to move to attended"],
		);
		expect(machine.notes.size, "every note taken away").toBe(0);
	});

	it("leaves untold a session whose window is Joel's or unplaced just before its tell", async () => {
		const machine = fakeMachine({
			ending: [["c"]],
			windows: {
				a: { where: "joel" },
				b: { where: { unplaced: "niri didn't answer: gone" } },
				c: { where: "away" },
			},
		});
		const report = await carryOut(
			[move("a", "attended"), move("b", "background"), move("c", "background")],
			machine.facts,
			60_000,
		);
		expect(machine.told).toEqual(["C>background"]);
		expect(report.moved).toEqual(["C"]);
		expect(report.spared).toEqual([
			{
				address: "A",
				why: "its window is on the workspace Joel has focused",
			},
			{
				address: "B",
				why: "its window can't be placed, so may be Joel's: niri didn't answer: gone",
			},
		]);
		expect(report.places, "no place kept for a session left").toEqual([
			{ address: "C", said: "kept" },
		]);
	});

	it("tells a window on Joel's workspace only while he is still away", async () => {
		const machine = fakeMachine({
			ending: [["a"]],
			windows: { a: { where: "joel" }, c: { where: "joel" } },
			away: [true, false],
		});
		const report = await carryOut(
			[move("a", "background"), move("c", "background")],
			machine.facts,
			60_000,
		);
		expect(machine.told).toEqual(["A>background"]);
		expect(report.moved).toEqual(["A"]);
		expect(report.spared).toEqual([
			{ address: "C", why: "its window is on the workspace Joel has focused" },
		]);
	});

	it("leaves a session alone while its pi still runs", async () => {
		const machine = fakeMachine({
			ending: [],
			notes: [note("a", "attended", 42)],
		});
		const report = await carryOut(
			[move("a", "attended")],
			machine.facts,
			4_000,
		);
		expect(machine.adopted).toEqual([]);
		expect(report.waiting).toEqual([{ address: "A" }]);
	});

	it("says at the deadline what still holds each busy session", async () => {
		const machine = fakeMachine({
			ending: [],
			holds: { a: "background jobs are out" },
		});
		const report = await carryOut(
			[move("a", "background")],
			machine.facts,
			4_000,
		);
		expect(report).toEqual({
			moved: [],
			waiting: [{ address: "A", holds: "background jobs are out" }],
			refused: [],
			takenBack: [],
			places: [{ address: "A", said: "kept" }],
			spared: [],
		});
	});

	it("keeps asking a host that refused, saying each new reason once", async () => {
		let asked = 0;
		const machine = fakeMachine({
			ending: [["a"]],
			refuse: () => {
				asked += 1;
				return asked < 3 ? "rollout_refused, 2 stale" : undefined;
			},
		});
		const report = await carryOut(
			[move("a", "attended")],
			machine.facts,
			60_000,
		);
		expect(report.moved).toEqual(["A"]);
		expect(
			machine.said.filter((line) => line.includes("not adopted yet")),
		).toEqual(["A not adopted yet: rollout_refused, 2 stale"]);
	});

	it("reports a host still refusing at the deadline", async () => {
		const machine = fakeMachine({
			ending: [["a"]],
			refuse: () => "no work-attended host is listening",
		});
		const report = await carryOut(
			[move("a", "attended")],
			machine.facts,
			4_000,
		);
		expect(report).toEqual({
			moved: [],
			waiting: [],
			refused: [{ address: "A", why: "no work-attended host is listening" }],
			takenBack: [],
			places: [{ address: "A", said: "kept" }],
			spared: [],
		});
		expect(machine.claimed.size, "no claim left held").toBe(0);
		expect(
			[...machine.notes.keys()],
			"the note given back for its window to take",
		).toEqual(["a"]);
	});

	it("never gives back a note whose host rostered it before failing", async () => {
		const machine = fakeMachine({
			ending: [["a"]],
			refuse: () => "the work-background host didn't answer: socket hang up",
			kept: ["a"],
		});
		const report = await carryOut(
			[move("a", "background")],
			machine.facts,
			60_000,
		);
		expect(machine.givenBack, "no note for its window to take").toEqual([]);
		expect(machine.notes.size + machine.claimed.size).toBe(0);
		expect(report.moved).toEqual(["A"]);
		expect(report.refused).toEqual([]);
		expect(machine.said).toContain(
			"A kept by the background host, though the work-background host didn't answer: socket hang up",
		);
	});

	it("adopts nothing its own window took back, and says so", async () => {
		const machine = fakeMachine({ ending: [["a"]], takenBack: ["a"] });
		const report = await carryOut(
			[move("a", "background")],
			machine.facts,
			60_000,
		);
		expect(machine.adopted, "no second writer beside its plain pi").toEqual([]);
		expect(report.moved).toEqual([]);
		expect(report.waiting).toEqual([]);
		expect(report.takenBack).toEqual(["A"]);
		expect(machine.said).toContain("A taken back in its own window");
	});

	it("gives a release written since it was read back to the release", async () => {
		const machine = fakeMachine({ ending: [["a"]] });
		const claim = machine.facts.claim;
		machine.facts.claim = (session) => {
			const one = machine.notes.get(session);
			if (one) machine.notes.set(session, { ...one, to: "pi" });
			return claim(session);
		};
		const report = await carryOut(
			[move("a", "background")],
			machine.facts,
			4_000,
		);
		expect(machine.adopted).toEqual([]);
		expect(report.takenBack).toEqual([]);
		expect(machine.notes.get("a")?.to).toBe("pi");
	});

	it("finishes an earlier run's notes, and leaves a release's alone", async () => {
		const machine = fakeMachine({
			ending: [],
			notes: [
				note("left", "background", 0),
				note("done", "attended", 0),
				note("back", "pi", 0),
			],
			held: { done: "work-attended" },
		});
		const report = await carryOut([], machine.facts, 60_000);
		expect(machine.adopted).toEqual(["left>background"]);
		expect([...report.moved].sort()).toEqual(["DONE", "LEFT"]);
		expect([...machine.notes.keys()]).toEqual(["back"]);
	});

	it("moves a conversation from one host to the other only once the first lets it go", async () => {
		const machine = fakeMachine({
			ending: [],
			notes: [{ ...note("hop", "attended"), from: "work-background" }],
			held: { hop: "work-background" },
			leaving: [[], ["hop"]],
		});
		const report = await carryOut([], machine.facts, 60_000);
		expect(
			machine.said.some((line) => line.includes("held by the work-background")),
			"the host it leaves never counts as where it went",
		).toBe(false);
		expect(machine.adopted).toEqual(["hop>attended"]);
		expect(report.moved).toEqual(["HOP"]);
		expect(machine.notes.size, "its note taken away").toBe(0);
	});

	it("leaves a host-to-host move waiting while the host it leaves still holds it", async () => {
		const machine = fakeMachine({
			ending: [],
			notes: [{ ...note("hop", "attended"), from: "work-background" }],
			held: { hop: "work-background" },
		});
		const report = await carryOut([], machine.facts, 4_000);
		expect(machine.adopted).toEqual([]);
		expect(report.waiting).toEqual([{ address: "HOP" }]);
		expect([...machine.notes.keys()], "its note kept").toEqual(["hop"]);
	});
});
