import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { machineFacts, releaseFacts } from "../../../host/cutover/machine.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import type { MoveNote } from "../../../lib/internal/session/move.ts";
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

	it("reads a host not listening by what its roster keeps, and one listening that doesn't answer as unread", async () => {
		const { root, places: deep } = releasePlaces("taken");
		// A socket's path can't pass 103 bytes, so its folder sits just under TMPDIR.
		const runtimeDir = mkdtempSync(join(tmpdir(), "r-"));
		const places = { ...deep, runtimeDir, rosters: rosters([HOPPING]) };
		const socket = hostSocketPath("work", "attended", runtimeDir);
		const answering = (answer: (id: string) => string | undefined) =>
			createServer((client) => {
				client.on("data", (chunk) => {
					const { id } = JSON.parse(chunk.toString().split("\n")[0] ?? "{}");
					const line = answer(id);
					if (line === undefined) client.destroy();
					else client.end(`${line}\n`);
				});
			});
		const refusing = answering((id) =>
			JSON.stringify({
				v: 1,
				id,
				ok: false,
				error: { code: "busy", message: "still starting" },
			}),
		);
		const hangingUp = answering(() => undefined);
		const listen = (server: ReturnType<typeof createServer>) =>
			new Promise<void>((listening, failed) => {
				server.once("error", failed);
				server.listen(socket, listening);
			});
		const close = (server: ReturnType<typeof createServer>) =>
			new Promise((closed) => server.close(closed));
		const resting = {
			session: HOPPING,
			host: "work-background",
			kind: "background",
		};
		try {
			const facts = releaseFacts(places);
			expect(await facts.held(), "no host listening").toEqual({
				held: [resting],
				unread: [],
			});
			mkdirSync(join(runtimeDir, "pi-host"), { recursive: true });
			writeFileSync(socket, "");
			expect(
				await facts.held(),
				"a stale socket, nothing listening (ECONNREFUSED)",
			).toEqual({ held: [resting], unread: [] });
			rmSync(socket);
			await listen(refusing);
			expect(await facts.held()).toEqual({
				held: [resting],
				unread: [
					{
						kind: "attended",
						why: "the attended host refused its list: still starting",
					},
				],
			});
			await close(refusing);
			await listen(hangingUp);
			const hungUp = await facts.held();
			expect(hungUp.unread.map((one) => one.kind)).toEqual(["attended"]);
			expect(hungUp.unread[0]?.why).toMatch(
				/^the attended host's list couldn't be had: /,
			);
		} finally {
			await close(refusing);
			await close(hangingUp);
			rmSync(root, { recursive: true, force: true });
			rmSync(runtimeDir, { recursive: true, force: true });
			rmSync(places.rosters, { recursive: true, force: true });
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
