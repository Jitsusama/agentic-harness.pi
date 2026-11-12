import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { machineFacts } from "../../../host/cutover/machine.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["AAAAAA"],
	groups: [],
	worksOn: "",
	owns: [],
	busy: false,
	state: "listening",
	at: "2026-11-10T09:00:00.000Z",
	...over,
});

const HOPPING = "01a1be5c-fff0-70a1-9301-f505d5634bf6";

/** A host's roster folder, keeping `sessions` for the background host. */
function rosters(sessions: string[]): string {
	const folder = mkdtempSync(join(tmpdir(), "cutover-rosters-"));
	writeFileSync(
		join(folder, "work-background.json"),
		JSON.stringify({
			v: 1,
			key: "work-background",
			sessions: sessions.map((sessionId) => ({
				sessionId,
				file: `/home/someone/.pi/sessions/${sessionId}.jsonl`,
				cwd: "/home/someone/src/core.nix",
				attended: false,
				since: "2026-11-11T00:30:00.000Z",
			})),
		}),
	);
	return folder;
}

/** A note a conversation leaving the background host wrote, naming its pid. */
const hop: MoveNote = {
	session: HOPPING,
	sessionFile: `/home/someone/.pi/sessions/${HOPPING}.jsonl`,
	cwd: "/home/someone/src/core.nix",
	to: "attended",
	at: "2026-11-11T00:30:00.000Z",
	addresses: ["HOPPER"],
	from: "work-background",
	pid: process.pid,
};

describe("machineFacts' running", () => {
	const places = () => ({
		realm: "work",
		runtimeDir: mkdtempSync(join(tmpdir(), "cutover-run-")),
		presence: mkdtempSync(join(tmpdir(), "cutover-presence-")),
	});

	it("says a conversation gone from the host it left, though that host still runs", async () => {
		const facts = machineFacts({ ...places(), rosters: rosters([]) });
		expect(
			await facts.running(hop),
			"the host's pid outlives it, so it isn't asked",
		).toBe(false);
	});

	it("keeps a conversation the host it left still keeps, even while that host is down", async () => {
		const facts = machineFacts({ ...places(), rosters: rosters([HOPPING]) });
		expect(
			await facts.running(hop),
			"its host takes it up again as it starts",
		).toBe(true);
	});
});

/** A harness root, knowing the move or not. */
function root(knows: boolean): string {
	const folder = mkdtempSync(join(tmpdir(), "cutover-root-"));
	if (knows) {
		mkdirSync(join(folder, "lib", "internal", "session"), { recursive: true });
		writeFileSync(join(folder, "lib", "internal", "session", "move.ts"), "");
	}
	return folder;
}

describe("machineFacts' holds", () => {
	it("says what holds a move waiting, or why one called itself off", async () => {
		const folder = mkdtempSync(join(tmpdir(), "cutover-presence-"));
		const said = (session: string, over: Partial<Presence>) =>
			writeFileSync(
				join(folder, `${session}.json`),
				JSON.stringify(presence({ session, ...over })),
			);
		said("waits", {
			moving: {
				to: "attended",
				since: "2026-11-12T15:00:00.000Z",
				holds: "a fleet is out (j2: k7-read)",
			},
		});
		said("gave-up", {
			moveOff: {
				to: "attended",
				since: "2026-11-12T15:00:00.000Z",
				at: "2026-11-12T15:45:00.000Z",
				why: "it waited 45 minutes and is still held: a fleet is out (j2: k7-read)",
			},
		});
		said("plain", {});
		const facts = machineFacts({ realm: "work", presence: folder });
		expect(await facts.holds("waits")).toBe("a fleet is out (j2: k7-read)");
		expect(await facts.holds("gave-up")).toBe(
			"called itself off: it waited 45 minutes and is still held: a fleet is out (j2: k7-read)",
		);
		expect(await facts.holds("plain")).toBeUndefined();
	});
});

describe("machineFacts' knowsMove", () => {
	it("takes a presence's word, which only a harness with the move says", async () => {
		const facts = machineFacts({ realm: "work" });
		expect(
			await facts.knowsMove(presence({ driven: false })),
			"a presence saying nobody drives it",
		).toBe(true);
		expect(
			await facts.knowsMove(presence({ driven: true })),
			"a presence saying a person drives it",
		).toBe(true);
		expect(
			await facts.knowsMove(presence()),
			"a presence that says neither",
		).toBe(false);
	});

	it("lets a parked pi that predates it move when the install it wakes on knows how", async () => {
		const parked = presence({ state: "parked" });
		expect(
			await machineFacts({ realm: "work", current: root(true) }).knowsMove(
				parked,
			),
			"waking on an install that knows the move",
		).toBe(true);
		expect(
			await machineFacts({ realm: "work", current: root(false) }).knowsMove(
				parked,
			),
			"waking on an install that predates it",
		).toBe(false);
		expect(
			await machineFacts({ realm: "work" }).knowsMove(parked),
			"with no install named",
		).toBe(false);
	});

	it("says Joel is away only while his presence mark is absent, and asks nothing without one", () => {
		const mark = join(
			mkdtempSync(join(tmpdir(), "cutover-mark-")),
			"someone-at-the-machine",
		);
		const facts = machineFacts({ realm: "work", presenceMark: mark });
		expect(facts.joelAway?.(), "no mark").toBe(true);
		writeFileSync(mark, "");
		expect(facts.joelAway?.(), "the mark there").toBe(false);
		rmSync(mark);
		expect(facts.joelAway?.(), "the mark gone again").toBe(true);
		expect(machineFacts({ realm: "work" }).joelAway).toBeUndefined();
	});
});
