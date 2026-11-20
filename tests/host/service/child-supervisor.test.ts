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
}

/** A shared roster in memory, refusing what the real one refuses. */
function fakeRoster(held: RosterEntry[]): FakeRoster {
	const holds = (sessionId: string) =>
		fake.held.some((one) => one.sessionId === sessionId);
	const fake: FakeRoster = {
		held,
		entries: () => [...fake.held],
		async hold(entry) {
			if (fake.refuses) throw new Error("The roster can't be written");
			if (holds(entry.sessionId)) throw new Error("Held already");
			fake.held = [...fake.held, entry];
		},
		async replace(previousId, entry) {
			if (!holds(previousId)) throw new Error("Conversation is not held");
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
	/** Each unit running, with its child once it listens. */
	readonly children: Map<string, FakeChild | undefined>;
	/** What the next child started does, when a test says. */
	next?: ChildTraits & { diesBeforeListening?: boolean };
}

/** How a fake child answers. */
interface ChildTraits {
	/** Refuse its open. */
	refuses?: boolean;
	/** Take every request and answer none. */
	silent?: boolean;
}

function slotNamed(unit: string): Slot {
	const name = unit.slice(unit.indexOf("@") + 1, -".service".length);
	return slotOf(folder, key, name);
}

/** Run a child in `slot`, as its unit would once its extensions load. */
async function runChild(
	slot: Slot,
	{ refuses, silent }: ChildTraits,
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
					socket.write(
						line({ v: 1, id, ok: true, result: child.conversation }),
					);
				} else if (request.op === "watch") {
					watchers.add(socket);
					socket.write(
						line({
							v: 1,
							id,
							ok: true,
							result: {
								version: "test",
								host: child.identity,
								conversation: child.conversation,
								entry: child.entry,
							},
						}),
					);
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
				runChild(slotNamed(unit), next, own).then(
					(child) => fake.children.set(unit, child),
					(error) => reported.push(error),
				);
			}, LISTENS_AFTER_MS);
		},
		async gone(unit) {
			return !fake.children.has(unit);
		},
		async stop(unit) {
			fake.stopped.push(unit);
			await fake.children.get(unit)?.exit();
			fake.children.delete(unit);
		},
	};
	return fake;
}

function childOf(sessionId: string): FakeChild {
	for (const child of units.children.values())
		if (child?.conversation?.sessionId === sessionId) return child;
	throw new Error(`No child runs ${sessionId}`);
}

function supervise(): ChildSupervisor {
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
	});
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
			"its child has gone",
		).toBe(false);
	});

	it("starts again in its slot only once the last child there has gone", async () => {
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

		expect(units.stopped).toEqual([slot.unit]);
		expect(existsSync(slot.file), "its slot is cleared").toBe(false);
		expect(said).toEqual([expect.stringContaining("could not be watched")]);
		expect(reported).toHaveLength(1);
	});

	it("leaves each child running when it stops watching", async () => {
		await supervisor.resume(entry(a));

		supervisor.close();

		expect(units.stopped).toEqual([]);
		expect(
			await units.gone(slotOf(folder, key, a).unit),
			"the child has gone",
		).toBe(false);
		await childOf(a).end("parked");
		// Nothing to wait on: an ending that arrives would come within this.
		await new Promise((resolve) => setTimeout(resolve, LISTENS_AFTER_MS));
		expect(ended, "no ending is taken from a child no longer watched").toEqual(
			[],
		);
	});
});
