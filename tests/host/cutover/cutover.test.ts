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
	held?: string[];
}) {
	const notes = new Map((script.notes ?? []).map((one) => [one.session, one]));
	const held = new Set(script.held ?? []);
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
		tell: (address, to) => {
			told.push(`${address}>${to}`);
			goes.set(address.toLowerCase(), to);
		},
		wake: (session) => woken.push(session),
		notes: () => [...notes.values()],
		removeNote: (session) => notes.delete(session),
		running: async (one) => one.pid !== 0,
		held: async () => {
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
			held.add(one.session);
			return undefined;
		},
		holds: async (session) => script.holds?.[session],
		now: () => clock,
		pause: async (ms) => {
			clock += ms;
		},
		say: (line) => said.push(line),
	};
	return { facts, told, woken, adopted, said, notes };
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
			places: [
				{ address: "A", said: "kept" },
				{ address: "B", said: "no window to keep" },
			],
		});
		expect(machine.said.slice(0, 2), "the place kept before the steer").toEqual(
			["A's window: kept", "told A to move to attended"],
		);
		expect(machine.notes.size, "every note taken away").toBe(0);
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
			places: [{ address: "A", said: "kept" }],
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
			places: [{ address: "A", said: "kept" }],
		});
	});

	it("finishes an earlier run's notes, and leaves a release's alone", async () => {
		const machine = fakeMachine({
			ending: [],
			notes: [
				note("left", "background", 0),
				note("done", "attended", 0),
				note("back", "pi", 0),
			],
			held: ["done"],
		});
		const report = await carryOut([], machine.facts, 60_000);
		expect(machine.adopted).toEqual(["left>background"]);
		expect([...report.moved].sort()).toEqual(["DONE", "LEFT"]);
		expect([...machine.notes.keys()]).toEqual(["back"]);
	});
});
