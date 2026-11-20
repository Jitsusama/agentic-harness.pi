/** The host starting, watching and taking up again the children that run its conversations. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChildSupervisor,
	childSupervisor,
	type KeptRoster,
} from "../../../host/service/child-supervisor.ts";
import {
	type Slot,
	slotOf,
	type Units,
	writeSlot,
} from "../../../host/service/child-units.ts";
import { heldChildren } from "../../../host/service/children.ts";
import type { HostIdentity } from "../../../host/service/dispatch.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";

const key = "work-background";
const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";
// How late a fake child listens after its unit starts, so the
// supervisor has to wait for it as it waits for a real one.
const LISTENS_AFTER_MS = 150;

let folder: string;
let routes: ReturnType<typeof heldChildren>;
let roster: FakeRoster;
let units: FakeUnits;
let reported: unknown[];
let said: string[];
let ended: [string, string][];
let supervisor: ChildSupervisor;

function conversation(sessionId: string): SessionIdentity {
	return {
		sessionId,
		file: join(folder, `${sessionId}.jsonl`),
		cwd: folder,
		state: "idle",
		since: "2026-11-20T02:00:00.000Z",
	};
}

function entry(sessionId: string): RosterEntry {
	return {
		sessionId,
		file: join(folder, `${sessionId}.jsonl`),
		cwd: folder,
		attended: false,
		since: "2026-11-20T02:00:00.000Z",
	};
}

/** What an open's child derives for its conversation, launch and all. */
function derived(sessionId: string): RosterEntry {
	return { ...entry(sessionId), attended: true, launch: { PI_ARM: "b" } };
}

interface FakeRoster extends KeptRoster {
	held: RosterEntry[];
	/** Refuse every hold, as a roster that can't be written would. */
	refuses?: boolean;
	/** Each hold waits on this before it writes, as a slow disk would. */
	written?: Promise<void>;
}

/**
 * A shared roster in memory, refusing a second hold of one id or one
 * file, on a hold or a replace, as the real one does; it takes any
 * launch, which only the real one's entries are checked for.
 */
function fakeRoster(held: RosterEntry[]): FakeRoster {
	const holds = (sessionId: string) =>
		fake.held.some((one) => one.sessionId === sessionId);
	const clashes = (entry: RosterEntry, besides?: string) =>
		fake.held.some(
			(one) =>
				one.sessionId !== besides &&
				(one.sessionId === entry.sessionId || one.file === entry.file),
		);
	const fake: FakeRoster = {
		held,
		entries: () => [...fake.held],
		async hold(entry) {
			await fake.written;
			if (fake.refuses) throw new Error("The roster can't be written");
			if (clashes(entry)) throw new Error("Held already");
			fake.held = [...fake.held, entry];
		},
		async replace(previousId, entry) {
			if (!holds(previousId)) throw new Error("Conversation is not held");
			if (clashes(entry, previousId)) throw new Error("Held already");
			fake.held = fake.held.map((one) =>
				one.sessionId === previousId ? entry : one,
			);
		},
		async drop(sessionId) {
			fake.held = fake.held.filter((one) => one.sessionId !== sessionId);
		},
	};
	return fake;
}

function line(value: unknown) {
	return `${JSON.stringify(value)}\n`;
}

/** One child as a test runs it: what it was asked, and what it says. */
interface FakeChild {
	readonly slot: Slot;
	readonly identity: HostIdentity;
	readonly asked: Record<string, unknown>[];
	conversation: SessionIdentity | undefined;
	entry: RosterEntry | undefined;
	/** Say a line on every watch. */
	say(value: unknown): void;
	/** Say it ends, then exit. */
	end(why: string): Promise<void>;
	/** Exit without a word. */
	exit(): Promise<void>;
}

interface FakeUnits extends Units {
	readonly started: string[];
	readonly stopped: string[];
	readonly forgotten: string[];
	/** Each unit running, with its child once it listens. */
	readonly children: Map<string, FakeChild | undefined>;
	/** What the next child started does, when a test says. */
	next?: ChildTraits & {
		diesBeforeListening?: boolean;
		neverListens?: boolean;
	};
	/** A stop is taken, but its unit runs on, as one systemd can't stop. */
	lingers?: boolean;
	/** How many of the next asks whether a unit has gone fail. */
	goneFails?: number;
}

/** How a fake child answers. */
interface ChildTraits {
	/** Refuse its open. */
	refuses?: boolean;
	/** Take every request and answer none. */
	silent?: boolean;
	/** Build what it is asked to open, but never answer the open. */
	opensUnanswered?: boolean;
	/** Say it ends in the same write as its watch's answer. */
	endsAsItAnswers?: boolean;
	/** What its watch's answer is made into, as a newer child's might be. */
	answers?: (result: Record<string, unknown>) => Record<string, unknown>;
}

function slotNamed(unit: string): Slot {
	const name = unit.slice(unit.indexOf("@") + 1, -".service".length);
	return slotOf(folder, key, name);
}

/** Run a child in `slot`, as its unit would once its extensions load. */
async function runChild(
	slot: Slot,
	{ refuses, silent, opensUnanswered, endsAsItAnswers, answers }: ChildTraits,
	pid: number,
): Promise<FakeChild> {
	const held = JSON.parse(await readFile(slot.file, "utf8"));
	await mkdir(slot.folder, { recursive: true });
	await writeFile(join(slot.folder, "roster.json"), "{}\n");
	const watchers = new Set<Socket>();
	const sockets = new Set<Socket>();
	let server: Server | undefined;
	const child: FakeChild = {
		slot,
		identity: { key, owner: { pid, startedAt: pid } },
		asked: [],
		conversation: held.session
			? conversation(held.session.sessionId)
			: undefined,
		entry: held.session,
		say(value) {
			for (const watcher of watchers) watcher.write(line(value));
		},
		async end(why) {
			child.say({ type: "ending", why });
			await child.exit();
		},
		async exit() {
			for (const socket of sockets) socket.end();
			await new Promise<void>((resolve) =>
				server ? server.close(() => resolve()) : resolve(),
			);
			units.children.delete(slot.unit);
		},
	};
	server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		const frames = jsonLines();
		socket.on("data", (chunk: Buffer) => {
			for (const value of frames.push(chunk)) {
				const request = value as Record<string, unknown>;
				child.asked.push(request);
				if (silent) continue;
				const id = request.id;
				if (request.op === "open") {
					if (refuses) {
						socket.write(
							line({
								v: 1,
								id,
								ok: false,
								error: { code: "invalid_request", message: "no such folder" },
							}),
						);
						continue;
					}
					const sessionId = randomUUID();
					child.conversation = conversation(sessionId);
					child.entry = derived(sessionId);
					if (opensUnanswered) continue;
					socket.write(
						line({ v: 1, id, ok: true, result: child.conversation }),
					);
				} else if (request.op === "watch") {
					watchers.add(socket);
					const result = {
						version: "test",
						host: child.identity,
						conversation: child.conversation,
						entry: child.entry,
					};
					const answer = line({
						v: 1,
						id,
						ok: true,
						result: answers ? answers(result) : result,
					});
					const ending = line({ type: "ending", why: "parked" });
					socket.write(endsAsItAnswers ? `${answer}${ending}` : answer);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(slot.socket, resolve));
	return child;
}

function fakeUnits(): FakeUnits {
	let pid = 100;
	const fake: FakeUnits = {
		started: [],
		stopped: [],
		forgotten: [],
		children: new Map(),
		async start(unit) {
			fake.started.push(unit);
			const next = fake.next ?? {};
			fake.next = undefined;
			// Held as running from the start, as systemd holds a unit it runs.
			fake.children.set(unit, undefined);
			pid += 1;
			const own = pid;
			// Late on purpose: a real unit's child listens a while after its
			// start, and the supervisor must wait that out.
			setTimeout(() => {
				if (next.diesBeforeListening) {
					fake.children.delete(unit);
					return;
				}
				if (next.neverListens) return;
				runChild(slotNamed(unit), next, own).then(
					(child) => fake.children.set(unit, child),
					(error) => reported.push(error),
				);
			}, LISTENS_AFTER_MS);
		},
		async gone(unit) {
			if (fake.goneFails) {
				fake.goneFails -= 1;
				throw new Error("systemd would not say");
			}
			return !fake.children.has(unit);
		},
		async stop(unit) {
			fake.stopped.push(unit);
			if (fake.lingers) return;
			await fake.children.get(unit)?.exit();
			fake.children.delete(unit);
		},
		async forget(unit) {
			fake.forgotten.push(unit);
		},
	};
	return fake;
}

function childOf(sessionId: string): FakeChild {
	for (const child of units.children.values())
		if (child?.conversation?.sessionId === sessionId) return child;
	throw new Error(`No child runs ${sessionId}`);
}

function supervise(
	clocks: { listensWithinMs?: number; exitsWithinMs?: number } = {},
): ChildSupervisor {
	return childSupervisor({
		key,
		folder,
		units,
		routes,
		roster,
		report: (error) => reported.push(error),
		say: (text) => said.push(text),
		ended: (sessionId, why) => ended.push([sessionId, why]),
		listensWithinMs: 5_000,
		answersWithinMs: 500,
		exitsWithinMs: 500,
		...clocks,
	});
}

/** An open request, as a caller sends one. */
function opening(id: string) {
	return {
		v: 1 as const,
		id,
		op: "open" as const,
		cwd: "/home",
		attended: true,
	};
}

/** A promise and what settles it, for a test to hold a step open. */
function deferred(): { promise: Promise<void>; settle: () => void } {
	let settle = (): void => undefined;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

function pauseFor(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
	// Short, since a socket's path may run to no more than 107 bytes.
	folder = await mkdtemp(join(tmpdir(), "cs-"));
	routes = heldChildren();
	// As a host holds what it resumes before it resumes it.
	roster = fakeRoster([entry(a)]);
	units = fakeUnits();
	reported = [];
	said = [];
	ended = [];
	supervisor = supervise();
});

afterEach(async () => {
	supervisor.close();
	for (const child of [...units.children.values()]) await child?.exit();
	await rm(folder, { recursive: true, force: true });
});

describe("a resumed conversation", () => {
	it("tells a child woken from a park that it was, so it doesn't rest parked again", async () => {
		await supervisor.resume(entry(a), true);

		const slot = slotOf(folder, key, a);
		expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
			session: entry(a),
			woken: true,
		});
	});

	it("starts its child in a slot naming its roster entry, and routes to it once it listens", async () => {
		const resumed = await supervisor.resume(entry(a));

		const slot = slotOf(folder, key, a);
		expect(units.started).toEqual([slot.unit]);
		expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
			session: entry(a),
		});
		expect(resumed.sessionId).toBe(a);
		expect(routes.routeOf(a)).toEqual({
			socket: slot.socket,
			identity: childOf(a).identity,
		});
		expect(routes.listed().map(({ sessionId }) => sessionId)).toEqual([a]);
		expect(roster.held, "held once").toEqual([entry(a)]);
		expect(reported).toEqual([]);
	});

	it("starts one child when it is asked for twice at once", async () => {
		const [first, second] = await Promise.all([
			supervisor.resume(entry(a)),
			supervisor.resume(entry(a)),
		]);
		const third = await supervisor.resume(entry(a));

		expect(units.started, "one unit started").toHaveLength(1);
		expect([first, second, third].map(({ sessionId }) => sessionId)).toEqual([
			a,
			a,
			a,
		]);
	});

	it("is given up within a second or two when its child ends before it listens", async () => {
		units.next = { diesBeforeListening: true };
		const asked = Date.now();

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			"ended before it listened",
		);
		expect(Date.now() - asked).toBeLessThan(3_000);
		expect(existsSync(slotOf(folder, key, a).file), "its slot is cleared").toBe(
			false,
		);
		expect(routes.routeOf(a)).toBeUndefined();
	});

	it("is given up, and its child stopped, when the child never answers its watch", async () => {
		units.next = { silent: true };

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			"no answer within",
		);

		expect(units.stopped).toEqual(units.started);
		expect(existsSync(slotOf(folder, key, a).file), "its slot is cleared").toBe(
			false,
		);
		expect(routes.routeOf(a)).toBeUndefined();
	});

	it("fails, starting nothing, for an id no slot can be named by", async () => {
		await expect(supervisor.resume(entry("not-an-id"))).rejects.toThrow(
			"Not a slot's name",
		);

		expect(units.started).toEqual([]);
	});

	it("fails, leaving its child running, when the host stops watching as it starts", async () => {
		const resuming = supervisor.resume(entry(a));

		supervisor.close();

		await expect(resuming).rejects.toThrow("stopped watching");
		expect(units.stopped).toEqual([]);
		expect(
			await units.gone(slotOf(folder, key, a).unit),
			"its child still runs",
		).toBe(false);
	});

	it("fails, keeping no watch, when the host stops watching as its hold is written", async () => {
		roster = fakeRoster([]);
		supervisor.close();
		supervisor = supervise();
		const writing = deferred();
		roster.written = writing.promise;
		const resuming = supervisor.resume(entry(a));
		await vi.waitFor(() =>
			expect(routes.routeOf(a), "its child answered").toBeDefined(),
		);

		supervisor.close();
		writing.settle();

		await expect(resuming).rejects.toThrow("stopped watching");
		await childOf(a).end("parked");
		await pauseFor(LISTENS_AFTER_MS);
		expect(ended, "no ending is taken from a child no longer watched").toEqual(
			[],
		);
		expect(units.stopped).toEqual([]);
	});

	it("is given up, naming its unit, when its child never listens", async () => {
		supervisor.close();
		supervisor = supervise({ listensWithinMs: 300 });
		units.next = { neverListens: true };

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`${slotOf(folder, key, a).unit} did not listen within 300 ms`,
		);
	});

	it("is refused, and its child stopped, when the child runs another conversation", async () => {
		units.next = {
			answers: (result) => ({ ...result, conversation: conversation(b) }),
		};

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`runs ${b}, not ${a} as asked`,
		);

		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
	});

	it("is refused when its child names one conversation and holds another", async () => {
		units.next = { answers: (result) => ({ ...result, entry: entry(b) }) };

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`runs ${a} but holds ${b}`,
		);

		expect(routes.listed()).toEqual([]);
	});

	it("refuses a second start in a slot whose child runs on as another", async () => {
		await supervisor.resume(entry(a));
		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(routes.routeOf(b)).toBeDefined());
		const route = routes.routeOf(b);

		await expect(supervisor.resume(entry(a))).rejects.toThrow(
			`A child runs in ${slotOf(folder, key, a).unit} already`,
		);

		expect(units.started, "no second child").toHaveLength(1);
		expect(units.stopped, "the running one is left be").toEqual([]);
		expect(routes.routeOf(b)).toEqual(route);
	});

	it("answers an ending said with its answer, keeping no watch", async () => {
		units.next = { endsAsItAnswers: true };

		const resumed = await supervisor.resume(entry(a));

		expect(resumed.sessionId).toBe(a);
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		expect(routes.routeOf(a)).toBeUndefined();
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
	});

	it("starts again in its slot only once the last child there has gone", async () => {
		// Room for the last child's exit, which the test times itself.
		supervisor.close();
		supervisor = supervise({ exitsWithinMs: 3_000 });
		await supervisor.resume(entry(a));
		const last = childOf(a);
		const slot = slotOf(folder, key, a);
		last.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));

		const again = supervisor.resume(entry(a), true);
		// The last child exits a little after it says it ends, as a real
		// one does once it has parked, while the wake's start waits on it.
		setTimeout(() => void last.exit(), LISTENS_AFTER_MS);
		await again;

		expect(units.started).toEqual([slot.unit, slot.unit]);
		expect(units.stopped, "the last one exited by itself").toEqual([]);
		expect(JSON.parse(await readFile(slot.file, "utf8"))).toEqual({
			session: entry(a),
			woken: true,
		});
		const now = childOf(a);
		expect(now, "a new child").not.toBe(last);
		expect(routes.routeOf(a)?.identity).toEqual(now.identity);
	});
});

describe("what a child says", () => {
	it("keeps the state it reports in the list", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "busy" },
		});

		await vi.waitFor(() =>
			expect(routes.listed()[0]?.state, "the state the child said").toBe(
				"busy",
			),
		);
	});

	it("moves the route when its conversation becomes another", async () => {
		await supervisor.resume(entry(a));
		const route = routes.routeOf(a);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(routes.routeOf(b)).toEqual(route));
		expect(routes.routeOf(a)).toBeUndefined();
		await vi.waitFor(() =>
			expect(roster.held, "held in the old one's place").toEqual([entry(b)]),
		);
	});

	it("holds what its conversation became when the roster no longer held it", async () => {
		await supervisor.resume(entry(a));
		roster.held = [];

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));
		expect(reported).toEqual([]);
	});

	it("lets the hold of what its conversation became go when it closes", async () => {
		await supervisor.resume(entry(a));
		const child = childOf(a);
		child.say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});
		await vi.waitFor(() => expect(roster.held).toEqual([entry(b)]));

		await child.end("closed");

		await vi.waitFor(() => expect(ended).toEqual([[b, "closed"]]));
		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
		expect(routes.routeOf(b)).toBeUndefined();
	});

	it("moves no route onto a conversation another child runs", async () => {
		roster.held = [entry(a), entry(b)];
		await supervisor.resume(entry(a));
		await supervisor.resume(entry(b));
		const route = routes.routeOf(b);

		childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversation(b),
			entry: entry(b),
		});

		await vi.waitFor(() =>
			expect(String(reported[0])).toContain("which another child runs"),
		);
		expect(routes.routeOf(b)).toEqual(route);
		expect(routes.routeOf(a)).toBeDefined();
	});

	it("lets the route and the slot go when the child says it ends", async () => {
		await supervisor.resume(entry(a));
		const slot = slotOf(folder, key, a);

		await childOf(a).end("parked");

		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		expect(routes.routeOf(a)).toBeUndefined();
		await vi.waitFor(() => {
			expect(existsSync(slot.file), "the slot's file is gone").toBe(false);
			expect(existsSync(slot.folder), "the child's own folder is gone").toBe(
				false,
			);
		});
		expect(said).toEqual([
			expect.stringContaining("its process ended, parked"),
		]);
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
		await vi.waitFor(() =>
			expect(units.forgotten, "systemd forgets its unit").toEqual([slot.unit]),
		);
	});

	it("lets the roster's hold go only when the child says it closed", async () => {
		await supervisor.resume(entry(a));

		await childOf(a).end("closed");

		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
	});

	it("stops trusting a child that says what it can't read", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(() => expect(ended).toEqual([[a, "failed"]]));
		expect(routes.routeOf(a)).toBeUndefined();
		const slot = slotOf(folder, key, a);
		await vi.waitFor(() => {
			expect(units.stopped, "the child, still running, is stopped").toEqual([
				slot.unit,
			]);
			expect(existsSync(slot.file), "its slot is cleared").toBe(false);
		});
	});

	it("gives a child that said it ends a while to exit, then stops it", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "ending", why: "parked" });

		const slot = slotOf(folder, key, a);
		await pauseFor(200);
		expect(units.stopped, "not stopped while it may still exit").toEqual([]);
		await vi.waitFor(
			() => {
				expect(units.stopped).toEqual([slot.unit]);
				expect(existsSync(slot.file), "its slot is cleared").toBe(false);
			},
			{ timeout: 3_000 },
		);
	});

	it("takes no word on another conversation than its own", async () => {
		await supervisor.resume(entry(a));
		const route = routes.routeOf(a);

		childOf(a).say({
			type: "became",
			previousId: b,
			conversation: conversation(a),
			entry: entry(a),
		});

		await vi.waitFor(() => expect(reported).toHaveLength(1));
		expect(routes.routeOf(a)).toEqual(route);
		expect(roster.held).toEqual([entry(a)]);
	});

	it("reads a line carrying more than it knows, as a newer child's would", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "busy", colour: "teal" },
		});

		await vi.waitFor(() => expect(routes.listed()[0]?.state).toBe("busy"));
		expect(ended).toEqual([]);
		expect(routes.listed()[0], "only what it reads").not.toHaveProperty(
			"colour",
		);
	});

	it("is watched when a newer child's answer carries more, nested too", async () => {
		units.next = {
			answers: (result) => ({
				...result,
				colour: "teal",
				host: {
					key,
					owner: { pid: 7, startedAt: 7, cgroup: "pi.slice" },
					region: "north",
				},
			}),
		};

		await supervisor.resume(entry(a));

		expect(routes.routeOf(a)?.identity).toEqual({
			key,
			owner: { pid: 7, startedAt: 7 },
		});
	});

	it("passes over a line of a kind it doesn't know, and says so", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "weather", sky: "clear" });
		childOf(a).say({
			type: "state",
			conversation: { ...conversation(a), state: "busy" },
		});

		await vi.waitFor(() => expect(routes.listed()[0]?.state).toBe("busy"));
		expect(ended).toEqual([]);
		expect(String(reported[0])).toContain("passed over a line");
	});

	it("takes an ending it can't read as a park, leaving the child to exit", async () => {
		await supervisor.resume(entry(a));

		childOf(a).say({ type: "ending", why: "migrated" });

		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
		expect(units.stopped, "given its while to exit").toEqual([]);
	});

	it("lets the roster's hold go when the child says it was released", async () => {
		await supervisor.resume(entry(a));

		await childOf(a).end("released");

		await vi.waitFor(() => expect(roster.held, "no hold left").toEqual([]));
	});

	it("counts a child that exits without a word as failed", async () => {
		await supervisor.resume(entry(a));

		await childOf(a).exit();

		await vi.waitFor(() => expect(ended).toEqual([[a, "failed"]]));
		expect(roster.held, "kept to resume later").toEqual([entry(a)]);
	});
});

describe("a child leaving", () => {
	it("keeps its slot in use while its unit won't stop, refusing a start there", async () => {
		await supervisor.resume(entry(a));
		units.lingers = true;

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(
			() => expect(String(reported.at(-1))).toContain("still runs"),
			{ timeout: 3_000 },
		);
		const slot = slotOf(folder, key, a);
		expect(existsSync(slot.file), "its slot is kept").toBe(true);
		await expect(supervisor.resume(entry(a))).rejects.toThrow("runs in");
		expect(units.started, "no second child beside it").toHaveLength(1);
	});

	it("keeps its slot in use when systemd won't say whether its unit went", async () => {
		await supervisor.resume(entry(a));
		units.goneFails = 1;

		childOf(a).say({ type: "became", previousId: "not an id" });

		await vi.waitFor(() =>
			expect(String(reported.at(-1))).toContain("would not say"),
		);
		await expect(supervisor.resume(entry(a))).rejects.toThrow("runs in");
		expect(units.started, "no second child beside it").toHaveLength(1);
	});
});

describe("a new conversation", () => {
	it("is opened by its child, which the host then routes to under the id it answers", async () => {
		const reply = await supervisor.begin({
			v: 1,
			id: "open-1",
			op: "open",
			cwd: "/home",
			attended: true,
			expectedHost: { key, owner: { pid: 1, startedAt: 1 } },
		});

		expect(reply).toMatchObject({ id: "open-1", ok: true });
		const opened = reply.ok ? (reply.result as SessionIdentity) : undefined;
		const child = childOf(opened?.sessionId ?? "");
		expect(child.asked[0], "asked without the host's identity").toEqual({
			v: 1,
			id: "open-1",
			op: "open",
			cwd: "/home",
			attended: true,
		});
		expect(routes.routeOf(opened?.sessionId ?? "")?.identity).toEqual(
			child.identity,
		);
		const slot = child.slot;
		expect(
			JSON.parse(await readFile(slot.file, "utf8")),
			"a slot naming none",
		).toEqual({});
		expect(roster.held, "held as its child derived it").toEqual([
			entry(a),
			derived(opened?.sessionId ?? ""),
		]);
	});

	it("tells the caller its child's refusal, and stops that child", async () => {
		units.next = { refuses: true };

		const reply = await supervisor.begin({
			v: 1,
			id: "open-2",
			op: "open",
			cwd: "/nowhere",
			attended: true,
		});

		expect(reply).toMatchObject({
			id: "open-2",
			ok: false,
			error: { message: "no such folder" },
		});
		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
		const slot = slotNamed(units.started[0] ?? "");
		expect(existsSync(slot.file), "its slot is cleared").toBe(false);
	});

	it("fails, and stops its child, when the roster won't hold what it opened", async () => {
		roster.refuses = true;

		await expect(
			supervisor.begin({
				v: 1,
				id: "open-3",
				op: "open",
				cwd: "/home",
				attended: true,
			}),
		).rejects.toThrow("can't be written");

		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
	});

	it("names the conversation a child built but never answered for, holding it", async () => {
		units.next = { opensUnanswered: true };

		const reply = await supervisor.begin(opening("open-5"));

		expect(reply).toMatchObject({
			id: "open-5",
			ok: false,
			error: { code: "open_unsettled" },
		});
		const [running] = routes.listed();
		expect(running, "routed to").toBeDefined();
		expect(reply.ok ? "" : reply.error.message).toContain(
			running?.sessionId ?? "none",
		);
		expect(roster.held).toEqual([
			entry(a),
			derived(running?.sessionId ?? ""),
		]);
		expect(units.stopped, "left running").toEqual([]);
	});

	it("asks nothing of its child when the host stops watching as it starts", async () => {
		const beginning = supervisor.begin(opening("open-6"));
		// Its unit has started, and its child listens a moment later.
		await vi.waitFor(() => expect(units.started).toHaveLength(1));

		supervisor.close();

		await expect(beginning).rejects.toThrow("stopped watching");
		await pauseFor(LISTENS_AFTER_MS * 2);
		const [child] = [...units.children.values()];
		expect(child?.asked ?? [], "nothing asked").toEqual([]);
		expect(units.stopped).toEqual([]);
	});

	it("tells the caller a child that never answers doesn't, and stops it", async () => {
		units.next = { silent: true };

		const reply = await supervisor.begin({
			v: 1,
			id: "open-4",
			op: "open",
			cwd: "/home",
			attended: true,
		});

		expect(reply).toMatchObject({
			id: "open-4",
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(units.stopped).toEqual(units.started);
	});
});

describe("a host starting again", () => {
	it("watches the children an earlier host left running and clears the slots of those gone", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		const gone = slotOf(folder, key, b);
		await writeFile(gone.file, line({ session: entry(b) }));
		routes = heldChildren();
		supervisor = supervise();

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(routes.routeOf(a)?.identity).toEqual(childOf(a).identity);
		expect(existsSync(gone.file), "the gone child's slot is cleared").toBe(
			false,
		);
		expect(units.started, "no child started again").toHaveLength(1);
	});

	it("holds again a child's conversation an earlier host never held", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		// As when a host ends between its child's open and its hold.
		roster = fakeRoster([]);
		routes = heldChildren();
		supervisor = supervise();

		await supervisor.adopt();

		expect(roster.held).toEqual([entry(a)]);
	});

	it("waits for an adopt rather than start a second child for one it takes up", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		routes = heldChildren();
		supervisor = supervise();

		const adopting = supervisor.adopt();
		const resumed = await supervisor.resume(entry(a));

		expect(await adopting, "children taken up").toBe(1);
		expect(resumed.sessionId).toBe(a);
		expect(units.started, "no child started again").toHaveLength(1);
	});

	it("stops a child it can't watch, and says so", async () => {
		const slot = slotOf(folder, key, b);
		await writeSlot(slot, entry(b));
		units.next = { silent: true };
		await units.start(slot.unit);
		await vi.waitFor(() =>
			expect(units.children.get(slot.unit), "it listens").toBeDefined(),
		);

		expect(await supervisor.adopt(), "children taken up").toBe(0);

		await vi.waitFor(() => {
			expect(units.stopped).toEqual([slot.unit]);
			expect(existsSync(slot.file), "its slot is cleared").toBe(false);
		});
		expect(said).toEqual([expect.stringContaining("could not be watched")]);
		expect(reported).toHaveLength(1);
	});

	it("holds a child that became another while nothing watched it in its slot's place", async () => {
		await supervisor.resume(entry(a));
		supervisor.close();
		const child = childOf(a);
		child.conversation = conversation(b);
		child.entry = entry(b);
		routes = heldChildren();
		supervisor = supervise();

		expect(await supervisor.adopt(), "children taken up").toBe(1);

		expect(roster.held, "one hold, under its new id").toEqual([entry(b)]);
		expect(routes.routeOf(b)?.socket).toBe(slotOf(folder, key, a).socket);
	});

	it("leaves a child that is leaving to the next host when it stops watching", async () => {
		await supervisor.resume(entry(a));
		const slot = slotOf(folder, key, a);
		childOf(a).say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[a, "parked"]]));

		supervisor.close();
		await pauseFor(800);

		expect(units.stopped, "not stopped after the host's stop").toEqual([]);
		expect(existsSync(slot.file), "its slot is left for an adopt").toBe(true);
	});

	it("leaves each child running when it stops watching", async () => {
		await supervisor.resume(entry(a));

		supervisor.close();

		expect(units.stopped).toEqual([]);
		expect(
			await units.gone(slotOf(folder, key, a).unit),
			"the child still runs",
		).toBe(false);
		await childOf(a).end("parked");
		// Nothing to wait on: an ending that arrives would come within this.
		await new Promise((resolve) => setTimeout(resolve, LISTENS_AFTER_MS));
		expect(ended, "no ending is taken from a child no longer watched").toEqual(
			[],
		);
	});
});
