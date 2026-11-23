/** Children a supervisor under test starts, watches and adopts: fake units, a fake roster, and children run in this process. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import {
	type ChildSupervisor,
	childSupervisor,
	type KeptRoster,
} from "../../../../host/service/child-supervisor.ts";
import {
	type Slot,
	slotOf,
	type Units,
} from "../../../../host/service/child-units.ts";
import { heldChildren } from "../../../../host/service/children.ts";
import type { HostIdentity } from "../../../../host/service/dispatch.ts";
import { jsonLines } from "../../../../host/service/framing.ts";
import type { SessionIdentity } from "../../../../host/service/protocol.ts";
import type { RosterEntry } from "../../../../lib/core/session/roster.ts";

export const key = "work-background";
export const a = "a0000000-0000-4000-8000-000000000001";
export const b = "b0000000-0000-4000-8000-000000000002";
/**
 * How late a fake child listens after its unit starts, so the
 * supervisor has to wait for it as it waits for a real one.
 */
export const LISTENS_AFTER_MS = 150;

// Each test's own, set afresh before it by superviseEachTest; read
// through these live bindings, and replaced only by superviseAgain.
export let folder: string;
export let routes: ReturnType<typeof heldChildren>;
export let roster: FakeRoster;
export let units: FakeUnits;
export let reported: unknown[];
export let said: string[];
export let ended: [string, string][];
/** What each child's conversation became, as the supervisor told it on. */
export let becameTold: [string, string][];
export let supervisor: ChildSupervisor;

/** A conversation as its child reports it. */
export function conversation(sessionId: string): SessionIdentity {
	return {
		sessionId,
		file: join(folder, `${sessionId}.jsonl`),
		cwd: folder,
		state: "idle",
		since: "2026-11-20T02:00:00.000Z",
	};
}

/** A conversation as the shared roster holds it. */
export function entry(sessionId: string): RosterEntry {
	return {
		sessionId,
		file: join(folder, `${sessionId}.jsonl`),
		cwd: folder,
		attended: false,
		since: "2026-11-20T02:00:00.000Z",
	};
}

/** The environment an open or adopt carries, which its child launches with. */
export const CARRIED = { PI_SANDBOX: "agent" };

/** What an open's child derives for its conversation, launch and all. */
export function derived(sessionId: string): RosterEntry {
	return { ...entry(sessionId), attended: true, launch: CARRIED };
}

/** The shared roster in memory, and what a test makes it do. */
export interface FakeRoster extends KeptRoster {
	held: RosterEntry[];
	/** Refuse every hold and replace, as a roster that can't be written would. */
	refuses?: boolean;
	/** Each hold or replace waits on this before it writes, as a slow disk would. */
	written?: Promise<void>;
}

/**
 * A shared roster in memory, refusing a second hold of one id or one
 * file, on a hold or a replace, as the real one does; it takes any
 * launch, which only the real one's entries are checked for.
 */
export function fakeRoster(held: RosterEntry[]): FakeRoster {
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
			await fake.written;
			if (fake.refuses) throw new Error("The roster can't be written");
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

/** One value as a line of the protocol. */
export function line(value: unknown) {
	return `${JSON.stringify(value)}\n`;
}

/** One child as a test runs it: what it was asked, and what it says. */
export interface FakeChild {
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

/** Units as systemd would run them, and what a test makes them do. */
export interface FakeUnits extends Units {
	readonly started: string[];
	readonly stopped: string[];
	/** For each stop, whether its slot's file said it forsaken as it was asked. */
	readonly markedAtStop: boolean[];
	readonly forgotten: string[];
	/** Each unit running, with its child once it listens. */
	readonly children: Map<string, FakeChild | undefined>;
	/** What the next child started does, when a test says. */
	next?: ChildTraits & {
		diesBeforeListening?: boolean;
		neverListens?: boolean;
		/** Listens no sooner than this settles, for a test to order a step. */
		listensWhen?: Promise<void>;
	};
	/**
	 * How long a stopped unit deactivates for after its stop returns, as
	 * systemd's `--no-block` stop returns once its job is queued.
	 */
	deactivatesForMs?: number;
	/** A stop is taken, but its unit runs on, as one systemd can't stop. */
	lingers?: boolean;
	/** Refuse the next start, as systemd refuses a unit it can't run. */
	refusesStart?: boolean;
	/** How many of the next asks whether a unit has gone fail. */
	goneFails?: number;
	/**
	 * The CPU time, in ms, each unit is said to have spent, when a test
	 * says, or what each ask answers; otherwise systemd is taken to say
	 * none it can tell.
	 */
	spent?: number | (() => number | undefined);
	/** How many times the CPU a unit spent was asked. */
	cpuAsks: number;
	/** The next ask whether a unit has gone answers only once this settles. */
	goneAnswers?: Promise<void>;
	/** How many of the next stops fail once their unit has gone. */
	stopFails?: number;
	/** The next stop returns, or fails, only once this settles. */
	stopReturns?: Promise<void>;
}

/** How a fake child answers. */
export interface ChildTraits {
	/** Refuse its open. */
	refuses?: boolean;
	/** The code it refuses with, when it refuses. */
	refusesWith?: string;
	/** Take every request and answer none. */
	silent?: boolean;
	/** Called as each connection to it is made, before it reads a line. */
	connected?: () => void;
	/** How many of its first watches it takes and answers none of. */
	unansweredWatches?: number;
	/** How long it takes to answer a watch, as a loaded child may. */
	answersWatchAfterMs?: number;
	/** The id it opens its conversation under, rather than a new one. */
	opensAs?: string;
	/** Build what it is asked to open, but never answer the open. */
	opensUnanswered?: boolean;
	/** Say it ends in the same write as its watch's answer. */
	endsAsItAnswers?: boolean;
	/** What its watch's answer is made into, as a newer child's might be. */
	answers?: (result: Record<string, unknown>) => Record<string, unknown>;
}

/** Whether the slot `unit` names says, as of now, that a host forsook it. */
function markedNow(unit: string): boolean {
	try {
		return (
			JSON.parse(readFileSync(slotNamed(unit).file, "utf8")).forsaken === true
		);
	} catch {
		// No file, or half written: no mark yet.
		return false;
	}
}

/** The slot a unit's instance names, in this test's folder. */
export function slotNamed(unit: string): Slot {
	const name = unit.slice(unit.indexOf("@") + 1, -".service".length);
	return slotOf(folder, key, name);
}

/**
 * Run a child in `slot`, as its unit would once its extensions load,
 * under the units `own` that started it.
 */
async function runChild(
	slot: Slot,
	traits: ChildTraits,
	pid: number,
	own: FakeUnits,
): Promise<FakeChild> {
	const { refuses, refusesWith, silent, opensUnanswered, opensAs } = traits;
	const { endsAsItAnswers, answers, connected, answersWatchAfterMs } = traits;
	let unansweredWatches = traits.unansweredWatches ?? 0;
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
			own.children.delete(slot.unit);
		},
	};
	server = createServer((socket) => {
		sockets.add(socket);
		connected?.();
		socket.on("error", () => undefined);
		const frames = jsonLines();
		socket.on("data", (chunk: Buffer) => {
			for (const value of frames.push(chunk)) {
				const request = value as Record<string, unknown>;
				child.asked.push(request);
				if (silent) continue;
				const id = request.id;
				// An adopt is answered as an open is, under an id of its own.
				if (request.op === "open" || request.op === "adopt") {
					if (refuses) {
						const code = refusesWith ?? "invalid_request";
						socket.write(
							line({
								v: 1,
								id,
								ok: false,
								error: { code, message: "no such folder" },
							}),
						);
						continue;
					}
					const sessionId = opensAs ?? randomUUID();
					child.conversation = conversation(sessionId);
					child.entry = derived(sessionId);
					if (opensUnanswered) continue;
					socket.write(
						line({ v: 1, id, ok: true, result: child.conversation }),
					);
				} else if (request.op === "watch") {
					if (unansweredWatches > 0) {
						unansweredWatches -= 1;
						continue;
					}
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
					const write = (): void => {
						socket.write(endsAsItAnswers ? `${answer}${ending}` : answer);
					};
					if (answersWatchAfterMs === undefined) write();
					else setTimeout(write, answersWatchAfterMs);
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
		markedAtStop: [],
		forgotten: [],
		children: new Map(),
		cpuAsks: 0,
		async start(unit) {
			fake.started.push(unit);
			if (fake.refusesStart) {
				fake.refusesStart = false;
				throw new Error(`Failed to start ${unit}: Unit not found`);
			}
			const next = fake.next ?? {};
			fake.next = undefined;
			// Held as running from the start, as systemd holds a unit it runs.
			fake.children.set(unit, undefined);
			pid += 1;
			const its = pid;
			// Named now, in this test's folder, should it listen after the test.
			const slot = slotNamed(unit);
			// Late on purpose: a real unit's child listens a while after its
			// start, and the supervisor must wait that out.
			setTimeout(async () => {
				await next.listensWhen;
				if (next.diesBeforeListening) {
					fake.children.delete(unit);
					return;
				}
				if (next.neverListens) return;
				runChild(slot, next, its, fake).then(
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
			const answers = fake.goneAnswers;
			fake.goneAnswers = undefined;
			await answers;
			return !fake.children.has(unit);
		},
		async stop(unit) {
			fake.stopped.push(unit);
			fake.markedAtStop.push(markedNow(unit));
			if (fake.lingers) return;
			const deactivating = fake.deactivatesForMs;
			if (deactivating !== undefined) {
				const child = fake.children.get(unit);
				setTimeout(() => {
					void child?.exit().finally(() => fake.children.delete(unit));
					if (!child) fake.children.delete(unit);
				}, deactivating);
				return;
			}
			await fake.children.get(unit)?.exit();
			fake.children.delete(unit);
			const returns = fake.stopReturns;
			fake.stopReturns = undefined;
			await returns;
			if (fake.stopFails) {
				fake.stopFails -= 1;
				throw new Error(`Failed to stop ${unit}: Connection timed out`);
			}
		},
		async forget(unit) {
			fake.forgotten.push(unit);
		},
		async cpuSpentMs(unit) {
			fake.cpuAsks += 1;
			if (!fake.children.has(unit)) return undefined;
			return typeof fake.spent === "function" ? fake.spent() : fake.spent;
		},
	};
	return fake;
}

/** The child running `sessionId`, which a test expects there is. */
export function childOf(sessionId: string): FakeChild {
	for (const child of units.children.values())
		if (child?.conversation?.sessionId === sessionId) return child;
	throw new Error(`No child runs ${sessionId}`);
}

/** The clocks a supervisor keeps, for a test to shorten or lengthen. */
interface Clocks {
	listensWithinMs?: number;
	answersWithinMs?: number;
	exitsWithinMs?: number;
	beginsWithinMs?: number;
	unsettledWithinMs?: number;
	leastFirstAskMs?: number;
	listensWithinCpuMs?: number;
	starvedWithinMs?: number;
}

function supervise(clocks: Clocks = {}): ChildSupervisor {
	return childSupervisor({
		key,
		folder,
		units,
		routes,
		roster,
		report: (error) => reported.push(error),
		say: (text) => said.push(text),
		ended: (sessionId, why) => ended.push([sessionId, why]),
		became: (previousId, nextId) => becameTold.push([previousId, nextId]),
		listensWithinMs: 5_000,
		answersWithinMs: 500,
		exitsWithinMs: 500,
		...clocks,
	});
}

/**
 * Put a new supervisor in the last one's place, closing that one: with
 * other clocks, over a roster holding `held`, or, as the next host of
 * the key would, with routes of its own. Its units and folder stay.
 */
export function superviseAgain(
	again: { clocks?: Clocks; held?: RosterEntry[]; nextHost?: boolean } = {},
): void {
	supervisor.close();
	if (again.held) roster = fakeRoster(again.held);
	if (again.nextHost) routes = heldChildren();
	supervisor = supervise(again.clocks);
}

/** An adopt request, as a caller sends one for the file of `sessionId`. */
export function adopting(id: string, sessionId: string) {
	return {
		v: 1 as const,
		id,
		op: "adopt" as const,
		sessionFile: join(folder, `${sessionId}.jsonl`),
		attended: true,
		env: CARRIED,
	};
}

/** An open request, as a caller sends one. */
export function opening(id: string) {
	return {
		v: 1 as const,
		id,
		op: "open" as const,
		cwd: "/home",
		attended: true,
		env: CARRIED,
	};
}

/** A promise and what settles it, for a test to hold a step open. */
export function deferred(): { promise: Promise<void>; settle: () => void } {
	let settle = (): void => undefined;
	const promise = new Promise<void>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

/**
 * CPU said from `from` at its first ask, growing `perSecond` ms a second
 * of the clock the supervisor judges by (`Date.now`) from then, as a
 * starved child's grows with time, not with how often systemd is asked:
 * an ask a second late finds a second's more. The supervisor runs on the
 * real clock, its children answering on real sockets, which fake timers
 * can't drive, so this is the clock the fake follows.
 */
export function growing(from: number, perSecond: number): () => number {
	let first: number | undefined;
	return () => {
		first ??= Date.now();
		return from + Math.floor((perSecond * (Date.now() - first)) / 1_000);
	};
}

/** A pause of `ms`, for a test to show something did not happen. */
export function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give each test of the file calling this a supervisor of its own over
 * a fresh folder, holding conversation `a`, and end its children after.
 */
export function superviseEachTest(): void {
	beforeEach(async () => {
		// Short, since a socket's path may run to no more than 103 bytes.
		folder = await mkdtemp(join(tmpdir(), "cs-"));
		routes = heldChildren();
		// As a host holds what it resumes before it resumes it.
		roster = fakeRoster([entry(a)]);
		units = fakeUnits();
		reported = [];
		said = [];
		ended = [];
		becameTold = [];
		supervisor = supervise();
	});

	afterEach(async () => {
		supervisor.close();
		for (const child of [...units.children.values()]) await child?.exit();
		await rm(folder, { recursive: true, force: true });
	});
}
