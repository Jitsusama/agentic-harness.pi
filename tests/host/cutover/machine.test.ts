import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { machineFacts, releaseFacts } from "../../../host/cutover/machine.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";
import type { MoveOff } from "../../../lib/mesh/moving.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { waitingSteers } from "../../../lib/mesh/steer.ts";

/** A release's places in a fresh folder, its launcher answering `answer`. */
function releasePlaces(answer: string) {
	const root = mkdtempSync(join(tmpdir(), "release-facts-"));
	const asked: string[] = [];
	return {
		root,
		asked,
		places: {
			realm: "work",
			runtimeDir: join(root, "run"),
			presence: join(root, "presence"),
			steer: join(root, "steer"),
			moves: join(root, "moves"),
			quests: join(root, "quests"),
			launcher: async (argument: string) => {
				asked.push(argument);
				return answer;
			},
		},
	};
}

/** The note a conversation let go to plain pi left, in `cwd`. */
const letGo = (cwd: string): MoveNote => ({
	session: HOPPING,
	sessionFile: `/home/someone/.pi/sessions/${HOPPING}.jsonl`,
	cwd,
	to: "pi",
	at: "2026-11-15T10:53:25.000Z",
	addresses: ["HOPPER"],
	from: "work-background",
	pid: process.pid,
});

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

/** A presence folder whose writer says each session's presence. */
function presences() {
	const folder = mkdtempSync(join(tmpdir(), "cutover-presence-"));
	const said = (session: string, over: Partial<Presence>) =>
		writeFileSync(
			join(folder, `${session}.json`),
			JSON.stringify(presence({ session, ...over })),
		);
	return { folder, said };
}

const GAVE_UP: MoveOff = {
	to: "attended",
	since: "2026-11-12T15:00:00.000Z",
	at: "2026-11-12T15:45:00.000Z",
	why: "it waited 45 minutes and is still held: a fleet is out (j2: k7-read)",
};

describe("machineFacts' holds", () => {
	it("says what holds a move waiting, or why one called itself off", async () => {
		const { folder, said } = presences();
		said("waits", {
			moving: {
				to: "attended",
				since: "2026-11-12T15:00:00.000Z",
				holds: "a fleet is out (j2: k7-read)",
			},
		});
		said("gave-up", { moveOff: GAVE_UP });
		said("plain", {});
		const facts = machineFacts({ realm: "work", presence: folder });
		expect(await facts.holds("waits")).toBe("a fleet is out (j2: k7-read)");
		expect(await facts.holds("gave-up")).toBe(
			"called itself off: it waited 45 minutes and is still held: a fleet is out (j2: k7-read)",
		);
		expect(await facts.holds("plain")).toBeUndefined();
	});
});

describe("machineFacts' calledOff", () => {
	it("gives the move a presence says was called off, only while none waits", async () => {
		const { folder, said } = presences();
		said("gave-up", { moveOff: GAVE_UP });
		said("asked-again", {
			moveOff: GAVE_UP,
			moving: { to: "attended", since: "2026-11-12T16:00:00.000Z" },
		});
		said("plain", {});
		const facts = machineFacts({ realm: "work", presence: folder });
		expect(await facts.calledOff("gave-up")).toEqual(GAVE_UP);
		expect(
			await facts.calledOff("asked-again"),
			"a move asked again since",
		).toBeUndefined();
		expect(await facts.calledOff("plain")).toBeUndefined();
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

describe("releaseFacts", () => {
	it("hands the launcher one let go, back where its window was", async () => {
		const { root, asked, places } = releasePlaces("taken");
		try {
			const facts = releaseFacts(places);
			expect(await facts.reopen(letGo(root)), "the launcher took it").toBe(
				true,
			);
			expect(asked.map((one) => JSON.parse(one))).toEqual([
				{
					sessions: [
						{ id: HOPPING, cwd: root, replaces: HOPPING, focus: false },
					],
				},
			]);
			const refused = releaseFacts(releasePlaces("refused: busy").places);
			expect(
				await refused.reopen(letGo(root)),
				"one the launcher refused stays offered",
			).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens none whose folder is gone, since pi would ask to fork it", async () => {
		const { root, asked, places } = releasePlaces("taken");
		try {
			const facts = releaseFacts(places);
			expect(
				await facts.reopen(letGo(join(root, "released-tree"))),
				"left offered",
			).toBe(false);
			expect(asked, "the launcher never asked").toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads a pi of its own as taking it up, not the host's stale presence", () => {
		const { root, places } = releasePlaces("taken");
		try {
			const facts = releaseFacts(places);
			const says = (over: Partial<Presence>) => {
				mkdirSync(places.presence, { recursive: true });
				writeFileSync(
					join(places.presence, `${HOPPING}.json`),
					JSON.stringify(presence({ session: HOPPING, ...over })),
				);
			};
			expect(facts.takenUp(HOPPING), "no presence").toBe(false);
			says({
				owner: { pid: process.pid, startedAt: 1 },
				hosted: { host: "work-background", conversation: "c1" },
			});
			expect(facts.takenUp(HOPPING), "its host's, outlasting it").toBe(false);
			says({ owner: { pid: process.pid, startedAt: 1 } });
			expect(facts.takenUp(HOPPING), "a live pi of its own").toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads a host not listening as holding none, and refuses the look of one that won't say", async () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "rh-"));
		const served: Server[] = [];
		/** A host at `kind`'s socket answering every request with `reply`. */
		const host = async (kind: "attended" | "background", reply: unknown) => {
			const server = createServer((client) => {
				client.once("data", (chunk) => {
					const { id } = JSON.parse(chunk.toString());
					client.end(`${JSON.stringify({ v: 1, id, ...(reply as object) })}\n`);
				});
			});
			served.push(server);
			await new Promise<void>((listening) =>
				server.listen(hostSocketPath("work", kind, runtimeDir), listening),
			);
		};
		try {
			mkdirSync(join(runtimeDir, "pi-host"), { recursive: true });
			const facts = releaseFacts({ realm: "work", runtimeDir });
			expect(await facts.held(), "neither host listening").toEqual([]);
			await host("background", {
				ok: false,
				error: { code: "busy", message: "the host is busy" },
			});
			await expect(facts.held(), "one that won't say").rejects.toThrow(
				"the background host didn't say what it holds: the host is busy",
			);
		} finally {
			await Promise.all(
				served.map(
					(server) =>
						new Promise((closed) => {
							server.close(closed);
						}),
				),
			);
			rmSync(runtimeDir, { recursive: true, force: true });
		}
	});

	it("calls a move off as the person at the desk would", async () => {
		const { root, places } = releasePlaces("taken");
		try {
			releaseFacts(places).callOff("HOPPER");
			expect(
				(await waitingSteers(join(places.steer, "HOPPER"))).map(
					({ act, from, text }) => ({ act, from, text }),
				),
			).toEqual([{ act: "resume", from: "joel", text: "" }]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
