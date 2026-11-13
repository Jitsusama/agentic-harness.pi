/**
 * Spike (worker per awake engine), never merged: the engine the service
 * drives when every awake conversation runs in a worker thread of its
 * own (worker-entry.ts), so one conversation's loading, turn or frame
 * holds only its own loop. The main thread keeps what the service owns:
 * the roster, the socket, the host's list and registry, the viewers'
 * connections, and the wake files of parked conversations. Each worker
 * runs the ordinary engine and pi's screen for its conversation, and says
 * back what it holds and how each stands, which this mirrors into the
 * main thread's SessionHost, so the backend reads it as it reads the one
 * engine.
 *
 * A conversation's worker starts with its open or its wake and ends once
 * it parks or closes, so a parked conversation holds no isolate. The
 * viewers of one that parks stay on the main thread, their keys kept for
 * the wake the first of them asks for, then attached again to its next
 * worker. What a worker can't do, and what this spike leaves out, is in
 * the spike's report, not here.
 */
import { Worker } from "node:worker_threads";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { readParked } from "../../lib/internal/session/park.ts";
import type {
	AdoptRequest,
	ConversationEvents,
	OpenRequest,
	Prepared,
} from "../service/backend.ts";
import type { ControlRequest } from "../service/protocol.ts";
import type {
	ViewerBridge,
	ViewerConnection,
	ViewerSink,
} from "../service/server.ts";
import type { EngineKey, HostEngine } from "./contract.ts";
import { PARKED, parking } from "./parking.ts";
import type {
	ConversationIdentity,
	SessionHost,
} from "./session-host.ts";
import { type Channel, openChannel, revived } from "./worker-channel.ts";
import type { WorkerSetup, WorkerWeight } from "./worker-setup.ts";

/** What lib/core/viewer/terminal.ts tells viewers, kept here so the main thread loads no pi-tui. */
const CLOSED = "Conversation closed";
const RELEASED = "Conversation released";
/** How long a worker told to end may take before it is terminated. */
const EXIT_MS = 5_000;
/** How long a worker may take to weigh itself. */
const WEIGH_MS = 8_000;

type AttachRequest = Extract<ControlRequest, { op: "attach" }>;
type HostedState = ConversationIdentity["state"];

/** A viewer connected to the main thread, relayed to its conversation's worker while awake. */
interface Relay {
	readonly id: number;
	readonly sessionId: string;
	request: AttachRequest;
	readonly sink: ViewerSink;
	/** The worker it is attached through, none while its conversation is parked. */
	seat?: Seat;
	/** What it typed while parked, for the screen it wakes into. */
	readonly buffered: string[];
}

/** One worker and what it holds. */
interface Seat {
	readonly worker: Worker;
	channel: Channel;
	readonly ready: Promise<void>;
	/** Conversations registered on the main thread for this worker. */
	readonly ids: Set<string>;
	/** Every conversation this worker ever registered. */
	readonly known: Set<string>;
	/** What the worker's own host lists now. */
	here: Set<string>;
	readonly viewers: Map<number, Relay>;
	/** Calls under way that may register a conversation: a prepare to its start, a resume. */
	busy: number;
	dead: boolean;
	exiting: boolean;
}

/** What the worker engine is made from. */
export interface WorkerEngineOptions {
	readonly packageDir: string;
	readonly stateDir: string;
	readonly home: string;
	readonly host: SessionHost;
	readonly env: NodeJS.ProcessEnv;
	readonly key?: EngineKey;
	/** Take a conversation's launch from its request, as the host program does. */
	readonly launchFromRequest?: boolean;
	readonly collectWhenQuiet?: boolean;
	readonly setup?: string;
	readonly report: (error: unknown) => void;
}

/** The engine, the viewers' bridge, and every worker's weighing. */
export interface WorkerEngine {
	readonly engine: HostEngine;
	readonly viewer: ViewerBridge;
	weigh(): Promise<WorkerWeight[]>;
	/** How many workers are running now. */
	workers(): number;
}

/** Make the worker engine over the main thread's SessionHost. */
export function createWorkerEngine(options: WorkerEngineOptions): WorkerEngine {
	const { host, report } = options;
	// The host's own environment, outside any conversation, for every worker.
	const spawnEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env))
		if (value !== undefined) spawnEnv[name] = value;
	const baseEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.env))
		if (value !== undefined) baseEnv[name] = value;
	const seats = new Set<Seat>();
	const seatOf = new Map<string, Seat>();
	const preparing = new Map<string, Seat>();
	const backgrounds = new Map<string, number>();
	const hows = new Map<string, "signalled" | "closed">();
	const parkedHandling = new Map<string, Promise<void>>();
	const asleep = new Map<string, Set<Relay>>();
	const waking = new Set<string>();
	let nextRelay = 0;
	let watched: ConversationEvents | undefined;
	const parked = parking({
		stateDir: options.stateDir,
		// The worker stopped it already; this side only watches its wake.
		stop: async () => undefined,
		asking: () => watched?.wake,
		report,
	});

	function setupFor(seat: { ids: Set<string> } | undefined): WorkerSetup {
		return {
			packageDir: options.packageDir,
			stateDir: options.stateDir,
			home: options.home,
			key: host.key,
			owner: host.owner,
			env: baseEnv,
			...(options.key ? { keyInherited: options.key.inherited } : {}),
			launchFromRequest: options.launchFromRequest ?? false,
			...(options.collectWhenQuiet === undefined
				? {}
				: { collectWhenQuiet: options.collectWhenQuiet }),
			...(options.setup ? { setup: options.setup } : {}),
			mirror: mirrorFor(seat),
		};
	}

	/** How the host's conversations stand, less the ones `seat` holds itself. */
	function mirrorFor(
		seat: { ids: Set<string> } | undefined,
	): [string, HostedState][] {
		return host
			.list()
			.filter(({ id }) => !seat?.ids.has(id))
			.map(({ id, state }) => [id, state]);
	}

	function broadcast(): void {
		for (const seat of seats)
			if (!seat.dead) seat.channel.tell("mirror", mirrorFor(seat));
	}

	function spawn(): Seat {
		let readied = (): void => undefined;
		let unready = (_error: unknown): void => undefined;
		const ready = new Promise<void>((resolve, reject) => {
			readied = resolve;
			unready = reject;
		});
		// Nothing else waits on it until the first call does.
		ready.catch(() => undefined);
		const worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
			workerData: setupFor(undefined),
			env: spawnEnv,
		});
		const seat: Seat = {
			worker,
			channel: undefined as never,
			ready,
			ids: new Set(),
			known: new Set(),
			here: new Set(),
			viewers: new Map(),
			busy: 0,
			dead: false,
			exiting: false,
		};
		seat.channel = openChannel(
			worker,
			{
				ready: () => readied(),
				list: (list, counts) => reconcile(seat, list, counts),
				background: (counts) => countsFrom(counts),
				parked: (sessionId) => parkedOut(seat, String(sessionId)),
				ended: (sessionId, why) =>
					endedIn(String(sessionId), String(why)).catch(report),
				report: (error) => report(revived(error)),
				write: (relay, data) =>
					seat.viewers.get(Number(relay))?.sink.write(String(data)),
				disconnect: (relay, reason) => {
					const one = seat.viewers.get(Number(relay));
					if (!one) return;
					seat.viewers.delete(one.id);
					one.seat = undefined;
					one.sink.disconnect(String(reason));
				},
				edit: (relay, id, text) =>
					seat.viewers.get(Number(relay))?.sink.edit(String(id), String(text)),
				suspend: (relay) => {
					const one = seat.viewers.get(Number(relay));
					if (!one) return;
					seat.viewers.delete(one.id);
					one.seat = undefined;
					one.sink.suspend();
				},
				became: async (previousId, next) => {
					await watched?.became(String(previousId), next as Prepared);
				},
				wake: async (sessionId) => {
					await watched?.wake?.(String(sessionId));
				},
				key: async () => options.key?.current(),
				refused: () => options.key?.refused(),
			},
			report,
		);
		worker.on("error", (error) => {
			unready(error);
			died(seat, error);
		});
		worker.on("exit", (code) => {
			const error = new Error(`its worker ended with ${code}`);
			unready(error);
			died(seat, error);
		});
		seats.add(seat);
		return seat;
	}

	function countsFrom(counts: unknown): void {
		if (typeof counts !== "object" || counts === null) return;
		for (const [id, count] of Object.entries(counts))
			backgrounds.set(id, Number(count));
	}

	/** Mirror what a worker's host lists into the main thread's. */
	function reconcile(seat: Seat, list: unknown, counts: unknown): void {
		const identities = Array.isArray(list)
			? (list as ConversationIdentity[])
			: [];
		seat.here = new Set(identities.map(({ id }) => id));
		countsFrom(counts);
		for (const one of identities) {
			if (!seat.known.has(one.id)) {
				seat.known.add(one.id);
				try {
					register(seat, one);
				} catch (error) {
					report(error);
					continue;
				}
			}
			if (!seat.ids.has(one.id)) continue;
			const now = host.holds(one.id);
			if (now === undefined || now === one.state) continue;
			try {
				host.state(one.id, one.state);
			} catch (error) {
				// Closing on this side already: its close says how it ends.
				if (!String(error).includes("closing")) report(error);
			}
		}
		broadcast();
	}

	function register(seat: Seat, one: ConversationIdentity): void {
		const { id } = one;
		host.register({
			id,
			file: one.file,
			cwd: one.cwd,
			env: {},
			close: (why) => closeIn(seat, id, why),
			stamp: (how) => {
				hows.set(id, how);
			},
			reload: async (request) => {
				await seat.channel.call("reload", id, request);
			},
		});
		seat.ids.add(id);
		seatOf.set(id, seat);
	}

	/** The main thread's close of a conversation: the worker's, unless it let go already. */
	async function closeIn(seat: Seat, id: string, why: string): Promise<void> {
		const how = hows.get(id) ?? "closed";
		try {
			if (!seat.dead && seat.here.has(id))
				await seat.channel.call("finish", id, why, how);
		} finally {
			hows.delete(id);
			seat.ids.delete(id);
			if (seatOf.get(id) === seat) seatOf.delete(id);
			backgrounds.delete(id);
			queueMicrotask(() => {
				broadcast();
				retireIfEmpty(seat);
			});
		}
	}

	/** A conversation ended itself in its worker: end it here, then tell the service. */
	async function endedIn(id: string, why: string): Promise<void> {
		await host.close(id, why).catch(report);
		await watched?.ended(id, why);
	}

	/** A conversation parked in its worker: let it go here, keep its viewers, and watch its wake. */
	function parkedOut(seat: Seat, id: string): void {
		seat.here.delete(id);
		const handled = (async () => {
			await host.stop(id, PARKED).catch(report);
			const kept = asleep.get(id) ?? new Set<Relay>();
			for (const relay of seat.viewers.values()) {
				relay.seat = undefined;
				kept.add(relay);
			}
			seat.viewers.clear();
			if (kept.size > 0) asleep.set(id, kept);
			parked.rests(id);
			retireIfEmpty(seat);
		})();
		parkedHandling.set(id, handled);
		void handled.finally(() => {
			if (parkedHandling.get(id) === handled) parkedHandling.delete(id);
		});
	}

	/** End a worker that holds nothing and is asked for nothing. */
	function retireIfEmpty(seat: Seat): void {
		if (seat.dead || seat.exiting) return;
		if (seat.busy > 0 || seat.ids.size > 0 || seat.here.size > 0) return;
		seat.exiting = true;
		const ended = setTimeout(() => {
			void seat.worker.terminate();
		}, EXIT_MS);
		ended.unref();
		seat.channel.call("exit").catch(() => undefined);
	}

	function died(seat: Seat, error: Error): void {
		if (seat.dead) return;
		seat.dead = true;
		seats.delete(seat);
		seat.channel.fail(error);
		for (const id of [...seat.ids]) {
			host.stop(id, error.message).catch(report);
		}
		for (const relay of seat.viewers.values())
			relay.sink.disconnect(`The conversation's worker ended: ${error.message}`);
		seat.viewers.clear();
		if (!seat.exiting) report(error);
	}

	/** The viewers kept while `id` was parked, attached to the worker it woke into. */
	function wakeViewers(id: string, seat: Seat): void {
		const kept = asleep.get(id);
		if (!kept) return;
		asleep.delete(id);
		for (const relay of kept) {
			relay.seat = seat;
			seat.viewers.set(relay.id, relay);
			seat.channel.tell("attach", relay.id, relay.request);
			for (const data of relay.buffered.splice(0))
				seat.channel.tell("input", relay.id, data);
		}
	}

	/** A viewer of a parked conversation typed: ask for its wake, once. */
	function wakeFor(relay: Relay): void {
		const id = relay.sessionId;
		if (waking.has(id)) return;
		const wake = watched?.wake;
		if (!wake) return;
		waking.add(id);
		wake(id)
			.catch((error: unknown) => {
				const said = error instanceof Error ? error.message : String(error);
				relay.sink.write(`\r\nThe wake failed: ${said}\r\n`);
			})
			.finally(() => waking.delete(id));
	}

	async function held(sessionId: string, file: string): Promise<boolean> {
		return (
			preparing.has(sessionId) ||
			host.holds(sessionId) !== undefined ||
			host.list().some((one) => one.file === file)
		);
	}

	const engine: HostEngine = {
		view: () => undefined,
		watch(events) {
			watched = events;
		},
		viewed() {},
		background() {
			let held = 0;
			for (const id of seatOf.keys()) held += backgrounds.get(id) ?? 0;
			return held;
		},
		backgroundOf: (sessionId) =>
			seatOf.has(sessionId) ? (backgrounds.get(sessionId) ?? 0) : 0,

		async prepare(request: OpenRequest | AdoptRequest) {
			const seat = spawn();
			seat.busy += 1;
			try {
				await seat.ready;
				const prepared = (await seat.channel.call(
					"prepare",
					request,
				)) as Prepared;
				if (await held(prepared.sessionId, prepared.file)) {
					await seat.channel.call("discard", prepared).catch(report);
					throw new Error(`Conversation already held: ${prepared.sessionId}`);
				}
				preparing.set(prepared.sessionId, seat);
				return prepared;
			} catch (error) {
				seat.busy -= 1;
				retireIfEmpty(seat);
				throw error;
			}
		},

		async start(prepared, request) {
			const seat = preparing.get(prepared.sessionId);
			if (!seat)
				throw new Error(`Conversation was not prepared: ${prepared.sessionId}`);
			preparing.delete(prepared.sessionId);
			try {
				await seat.channel.call("start", prepared, request);
			} finally {
				seat.busy -= 1;
				retireIfEmpty(seat);
			}
		},

		async discard(prepared) {
			const seat = preparing.get(prepared.sessionId);
			if (!seat) return;
			preparing.delete(prepared.sessionId);
			try {
				await seat.channel.call("discard", prepared);
			} finally {
				seat.busy -= 1;
				retireIfEmpty(seat);
			}
		},

		async resume(entry: RosterEntry, woken = false) {
			if (host.holds(entry.sessionId) !== undefined)
				throw new Error(`Conversation already running: ${entry.sessionId}`);
			const seat = spawn();
			seat.busy += 1;
			try {
				await seat.ready;
				await seat.channel.call("resume", entry, woken);
				parked.unwatch(entry.sessionId);
				wakeViewers(entry.sessionId, seat);
			} finally {
				seat.busy -= 1;
				retireIfEmpty(seat);
			}
		},

		restsParked(entry) {
			const { sessionId } = entry;
			if (host.holds(sessionId) !== undefined) return false;
			if (readParked(sessionId)?.wake !== parked.wakeFile(sessionId))
				return false;
			parked.rests(sessionId);
			return true;
		},

		async parkSettled(sessionId) {
			const seat = seatOf.get(sessionId);
			if (seat && !seat.dead)
				await seat.channel.call("parkSettled", sessionId).catch(() => undefined);
			await parkedHandling.get(sessionId);
		},

		async dropped(sessionId, why) {
			parked.closed(sessionId);
			const kept = asleep.get(sessionId);
			asleep.delete(sessionId);
			const told = why.startsWith("released") ? RELEASED : CLOSED;
			for (const relay of kept ?? []) relay.sink.disconnect(told);
		},

		async abort(sessionId) {
			const seat = seatOf.get(sessionId);
			if (!seat) throw new Error(`Conversation is not hosted: ${sessionId}`);
			await seat.channel.call("abort", sessionId);
		},
	};

	const viewer: ViewerBridge = {
		attach(request, sink): ViewerConnection {
			const relay: Relay = {
				id: nextRelay++,
				sessionId: request.sessionId,
				request: { ...request },
				sink,
				buffered: [],
			};
			const seat = seatOf.get(request.sessionId);
			if (seat && !seat.dead && seat.here.has(request.sessionId)) {
				relay.seat = seat;
				seat.viewers.set(relay.id, relay);
				seat.channel.tell("attach", relay.id, relay.request);
			} else {
				const kept = asleep.get(request.sessionId) ?? new Set<Relay>();
				kept.add(relay);
				asleep.set(request.sessionId, kept);
			}
			return {
				input(data) {
					if (relay.seat) relay.seat.channel.tell("input", relay.id, data);
					else {
						relay.buffered.push(data);
						wakeFor(relay);
					}
				},
				resize(rows, columns) {
					relay.request = { ...relay.request, rows, columns };
					relay.seat?.channel.tell("resize", relay.id, rows, columns);
				},
				edited(id, text) {
					relay.seat?.channel.tell("edited", relay.id, id, text);
				},
				detach() {
					if (relay.seat) {
						relay.seat.viewers.delete(relay.id);
						relay.seat.channel.tell("detach", relay.id);
						relay.seat = undefined;
					}
					asleep.get(relay.sessionId)?.delete(relay);
				},
			};
		},
	};

	return {
		engine,
		viewer,
		workers: () => seats.size,
		async weigh() {
			const weighed = await Promise.all(
				[...seats]
					.filter((seat) => !seat.dead && !seat.exiting)
					.map((seat) =>
						Promise.race([
							seat.channel.call("weigh") as Promise<WorkerWeight>,
							new Promise<undefined>((done) =>
								setTimeout(() => done(undefined), WEIGH_MS).unref(),
							),
						]).catch(() => undefined),
					),
			);
			return weighed.filter((one): one is WorkerWeight => one !== undefined);
		},
	};
}
