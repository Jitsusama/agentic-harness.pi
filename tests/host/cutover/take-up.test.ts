/**
 * The take-up /host starts: it waits for its one session's move note,
 * has the host adopt that log once its pi has gone, and leaves every
 * other session's note alone.
 */
import { describe, expect, it } from "vitest";
import type { MoveFacts } from "../../../host/cutover/cutover.ts";
import {
	type Standing,
	type TakeUpFacts,
	takeUp,
} from "../../../host/cutover/take-up.ts";
import type { HostKind } from "../../../host/service/address.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";

const note = (session: string, to: HostKind | "pi"): MoveNote => ({
	session,
	sessionFile: `/logs/${session}.jsonl`,
	cwd: "/work",
	to,
	at: "2026-11-11T21:00:00.000Z",
	addresses: [session.toUpperCase()],
	pid: 4242,
});

/**
 * A machine where the session stands as `standings` says at each look,
 * its note written at the look `notedAt` names, and its pi gone a look
 * after.
 */
function machine(script: {
	standings: Standing[];
	notedAt?: number;
	to?: HostKind | "pi";
	others?: MoveNote[];
}) {
	const notes = new Map(
		(script.others ?? []).map((one) => [one.session, one] as const),
	);
	const adopted: string[] = [];
	const said: string[] = [];
	let looks = 0;
	let clock = 0;
	let notedLook: number | undefined;
	const held = new Map<string, string>();
	const unused = (): never => {
		throw new Error("a take-up tells no session and keeps no place");
	};
	const facts: TakeUpFacts = {
		standing: async () => {
			const at = looks;
			looks += 1;
			if (at === script.notedAt) {
				notes.set("01a1", note("01a1", script.to ?? "background"));
				notedLook = at;
			}
			return (
				script.standings[Math.min(at, script.standings.length - 1)] ?? "moving"
			);
		},
		keepPlace: unused,
		windowNow: unused,
		tell: unused,
		wake: unused,
		notes: () => [...notes.values()],
		removeNote: (session) => {
			notes.delete(session);
		},
		claim: (session) => {
			const one = notes.get(session);
			notes.delete(session);
			return one;
		},
		giveBack: () => {},
		kept: async () => false,
		running: async () => notedLook !== undefined && looks <= notedLook + 1,
		held: async () => {
			looks += 1;
			return held;
		},
		adopt: async (one, to) => {
			adopted.push(`${one.session}>${to}`);
			held.set(one.session, `work-${to}`);
			return undefined;
		},
		holds: async () => undefined,
		now: () => clock,
		pause: async (ms) => {
			clock += ms;
		},
		say: (line) => said.push(line),
	} satisfies MoveFacts & TakeUpFacts;
	return { facts, adopted, said, notes };
}

describe("taking up a /host move", () => {
	it("waits for its session's note, then has the host adopt it once its pi has gone", async () => {
		const other = note("0b2c", "attended");
		const one = machine({
			standings: ["moving", "moving", "moving"],
			notedAt: 2,
			others: [other],
		});
		expect(await takeUp("01a1", one.facts, 60_000)).toBe("moved");
		expect(one.adopted).toEqual(["01a1>background"]);
		expect(one.notes.get("0b2c"), "another session's note left be").toEqual(
			other,
		);
	});

	it("ends with nothing adopted when the move is called off", async () => {
		const one = machine({ standings: ["moving", "off"] });
		expect(await takeUp("01a1", one.facts, 60_000)).toBe("called off");
		expect(one.adopted).toEqual([]);
	});

	it("ends when its pi has gone leaving no note", async () => {
		const one = machine({ standings: ["gone"] });
		expect(await takeUp("01a1", one.facts, 60_000)).toBe("gone");
		expect(one.adopted).toEqual([]);
	});

	it("gives up at its deadline with no note", async () => {
		const one = machine({ standings: ["moving"] });
		expect(await takeUp("01a1", one.facts, 10_000)).toBe("unfinished");
		expect(one.adopted).toEqual([]);
	});

	it("leaves a release's note to the release", async () => {
		const one = machine({ standings: ["moving", "off"], notedAt: 0, to: "pi" });
		expect(await takeUp("01a1", one.facts, 60_000)).toBe("called off");
		expect(one.adopted).toEqual([]);
	});
});
