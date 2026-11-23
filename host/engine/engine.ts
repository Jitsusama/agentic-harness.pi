/**
 * The engine the host service drives. Each conversation is pi's own
 * session, built by pi's runtime with the conversation's extensions loaded
 * under its id, on the host's agent and a durable store of its own. The
 * service decides when a conversation is held; the engine names it, starts
 * it, carries on what a restart cut off, and ends it, through SessionHost,
 * which owns who holds what. A conversation that becomes another (pi's
 * /new, /fork, /resume or import) is held under its new id before pi builds
 * it, and the one it was ends with it. A conversation left idle parks,
 * freeing its session while it stays held, and wakes in place (parking.ts);
 * while it is parked, the host keeps its cache warm (parked-warming.ts).
 * While the host holds a conversation, running or parked, it holds its log
 * open (held-logs.ts).
 *
 * This file holds a conversation's steps in the order each relies on
 * (register, begin, end, release) and the engine's answers to the
 * service. How pi builds, replaces and loses a session is in
 * conversation-build.ts; what its requests keep past a park, in
 * kept-requests.ts; what a stop keeps, a close ends and a restart would
 * end, in stopping.ts.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	HOST_RESTARTING_EVENT,
	type HostRestarting,
} from "../../lib/core/session/host.ts";
import {
	type LaunchHints,
	SESSION_STAMP_EVENT,
	type SessionStamp,
} from "../../lib/core/session/index.ts";
import type { RosterEntry } from "../../lib/core/session/roster.ts";
import { carryHoldsReload } from "../../lib/internal/carry/under-way.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	clearParked,
	readParked,
	WAKE_ENV,
} from "../../lib/internal/session/park.ts";
import type {
	AdoptRequest,
	ConversationEvents,
	OpenRequest,
	Prepared,
	ResumePhase,
} from "../service/backend.ts";
import { carriedShells } from "./carried-shells.ts";
import { checkpointing } from "./checkpoints.ts";
import type {
	ConversationTraits,
	EngineOptions,
	HostEngine,
} from "./contract.ts";
import { conversationBuilds, type Live } from "./conversation-build.ts";
import {
	HARNESS_SETTINGS_VARIABLE,
	type HarnessRequest,
	harnessSettings,
} from "./harness-settings.ts";
import { heldLogs } from "./held-logs.ts";
import { loadHostPi } from "./host-pi.ts";
import { KEY_VARIABLES, keptRequests } from "./kept-requests.ts";
import { parking } from "./parking.ts";
import { piLibrary } from "./pi-library.ts";
import {
	piBuiltInExtensions,
	piSessions,
	type SessionManager,
	sessionFileGone,
} from "./pi-session.ts";
import { projectTrust } from "./project-trust.ts";
import {
	type QuietCollection,
	type QuietReading,
	quietCollection,
	runningTools,
} from "./quiet-collection.ts";
import { adoptable, folder, hintsFor } from "./requests.ts";
import { resumeTurns, type TakeTurn } from "./resume-turns.ts";
import {
	backgroundIn,
	carryEnds,
	heavyIn,
	restartEnds,
	stopKeeping,
} from "./stopping.ts";
import {
	hostedSubagentInstall,
	pinSubagentInstall,
	pinSubagentKey,
} from "./subagent-install.ts";
import { conversationMarker, markAsOwner } from "./tool-children.ts";

/** A conversation prepare named, waiting for its start, with the launch derived for it. */
interface Preparing {
	readonly manager: SessionManager;
	readonly traits: ConversationTraits;
	readonly launch: Readonly<Record<string, string>>;
}

/** Load the host's pi and make the engine over the host's ownership. */
export async function createEngine(
	options: EngineOptions,
): Promise<HostEngine> {
	const pi = await loadHostPi(options.packageDir);
	// Only here, never at the top: kept history binds values from pi's
	// modules, which pi-host resolves from the host's install. Bound as
	// the program loads, a missing install would fail the import before
	// the program's configuration check refuses it with exit 78.
	const { holdKeptHistory } = await import("./kept-history.ts");
	// Before any conversation's extensions load, so the first subagent finds it.
	pinSubagentInstall(hostedSubagentInstall(pi));
	if (options.key) pinSubagentKey(options.key, KEY_VARIABLES);
	const sessions = piSessions(pi.modules);
	const builtIns = piBuiltInExtensions(pi.modules);
	const trust = projectTrust(pi.modules);
	const library = piLibrary(pi.modules);
	const { host } = options;
	const report = options.report ?? (() => {});
	// Before the service resumes or admits anything: what this host's dead predecessors' tools left running ends first, held or not.
	const owner = markAsOwner(report);
	const kept = options.oneConversation;
	const stopping = stopKeeping({
		stateDir: options.stateDir,
		...(kept ? { keptIn: kept.keptIn } : {}),
		report,
	});
	// A child's siblings on the key run on: the supervisor sweeps for the dead.
	if (!kept) await stopping.reapEarlier(host.key);
	const prepared = new Map<string, Preparing>();
	const live = new Map<string, Live>();
	const logs = heldLogs(report);
	// Only a start's resumes take one: a wake, an open or an adopt carries its run on at once.
	const turns = resumeTurns();
	// The bash calls a restart carries to the next host, kept through its stop.
	const shells = carriedShells({
		stateDir: options.stateDir,
		...(kept ? { keptIn: kept.keptIn } : {}),
		say: report,
		report,
	});
	// A park carries a conversation's bash calls where they outlive it: a
	// child's process ends once it parks, while a shared host runs on.
	// Its stop tells the conversation the host restarts, which is how the
	// conversation carries them and how `shells` hears of them, so a shared
	// host's own later stop keeps them too. PI_PARK_CARRY=off turns it off,
	// so a conversation with a call out stays awake, as before.
	const parkCarries = () =>
		process.env.PI_PARK_CARRY !== "off" &&
		shells.keepsThroughPark(kept !== undefined);
	// Conversations released to another holder, whose carried calls it takes up.
	const released = new Set<string>();
	// One whose carried calls couldn't be recorded carries none for a while.
	host.keepsCarried((sessionId) => parkCarries() && parked.mayCarry(sessionId));
	// What an earlier restart kept and no conversation here took up is
	// stopped once due; a child's are the supervisor's to look over.
	if (!kept) shells.watch((sessionId) => live.has(sessionId));
	let watched: ConversationEvents | undefined;
	const requests = keptRequests({ engine: options, sessions, report });
	const { warming } = requests;
	const parked = parking({
		stateDir: options.stateDir,
		stop: (sessionId, why, carrying) => host.stop(sessionId, why, carrying),
		carries: parkCarries,
		asking: () => watched?.wake,
		report,
		said: report,
		parked: (sessionId) => warming.start(sessionId),
		// The host serves one realm, its conversations' own (service/address.ts).
		steers: {
			root: stateDir("steer"),
			addressesOf: (sessionId) => readParked(sessionId)?.addresses ?? [],
		},
		// A conversation parked to let the host restart stays parked until
		// the drain lifts or the next host reads its wake.
		holding: () => host.drains(),
	});
	const tools = runningTools();
	// V8 keeps the pages its collections free until a memory-reducing one, so the host collects once it goes quiet.
	const quiet: QuietCollection =
		options.collectWhenQuiet === false
			? { stirred() {}, parked() {}, viewed() {}, stop() {} }
			: quietCollection({
					reading: quietReading,
					report,
					// A child's long pause holds only its own quiet conversation.
					forgetsPaces: kept !== undefined,
				});
	const { build, view, failedAfterStart } = conversationBuilds({
		parts: {
			pi,
			sessions,
			builtIns,
			trust,
			library,
			keptHistory: holdKeptHistory,
		},
		options,
		report,
		logs,
		requests,
		stopping,
		// One thread for the host's stores, started with the first and ended with the last.
		checkpoints: checkpointing({ report }),
		watched: () => watched,
		held,
		fileHeld,
		register,
		heard,
	});

	/** What a pause to collect would cost the conversations now. */
	function quietReading(): QuietReading {
		let running = 0;
		let jobs = 0;
		for (const [sessionId, record] of live) {
			running += tools.running(sessionId);
			jobs += backgroundIn(record);
		}
		const waiting = host
			.list()
			.filter(
				({ id, state }) => state === "busy" && tools.running(id) === 0,
			).length;
		return { tools: running, jobs, waiting };
	}

	function held(sessionId: string, file: string): boolean {
		return (
			prepared.has(sessionId) ||
			host.holds(sessionId) !== undefined ||
			fileHeld(file)
		);
	}

	function fileHeld(file: string): boolean {
		return (
			host.list().some((conversation) => conversation.file === file) ||
			[...prepared.values()].some(({ traits }) => traits.file === file)
		);
	}

	/** Register a conversation, then build it under its id; one that fails once registered stays held, parked. */
	async function begin(
		traits: ConversationTraits,
		manager: SessionManager,
		launch: Readonly<Record<string, string>>,
		request?: OpenRequest | AdoptRequest,
		mark?: (phase: ResumePhase) => void,
		turn?: TakeTurn,
	): Promise<void> {
		const { sessionId } = traits;
		const record = register(traits, launch, request, hintsFor(request));
		const asking = new Promise<"asking">((done) => {
			record.asked = () => done("asking");
		});
		const building = host
			.run(sessionId, () => build(record, manager, request, mark, turn))
			.then(
				() => "built" as const,
				(error: unknown) => {
					// Closed while it was built: the close has let it go, so there is nothing to park.
					if (record.closing) throw error;
					try {
						host.state(sessionId, "parked");
					} catch (parking) {
						// Closing already: the close parks it, and the start's error is what the caller must see.
						report(parking);
					}
					throw error;
				},
			);
		// A start whose screen is asking the person answers now, so a viewer can attach to answer; the build carries on, and says what fails.
		if ((await Promise.race([building, asking])) === "asking")
			building.catch((error: unknown) => failedAfterStart(record, error));
	}

	/**
	 * Hold a conversation with the host under its id, its environment the
	 * realm's, then its launch, then what the engine derives for this start.
	 */
	function register(
		traits: ConversationTraits,
		launch: Readonly<Record<string, string>>,
		request: HarnessRequest | undefined,
		hints: LaunchHints,
	): Live {
		const { sessionId } = traits;
		const record: Live = { traits, launch, bus: sessions.createEventBus() };
		// Held here again: a release before says nothing of its next close.
		released.delete(sessionId);
		shells.heard(record.bus);
		parked.hears(sessionId, record.bus);
		host.register({
			id: sessionId,
			file: traits.file,
			cwd: traits.cwd,
			// What the engine derives comes after the launch, every start, so a held launch never overrides it.
			env: {
				...options.env,
				...launch,
				[HARNESS_SETTINGS_VARIABLE]: harnessSettings(
					options.env[HARNESS_SETTINGS_VARIABLE],
					{ attended: traits.attended },
					request,
					{ version: pi.version },
				),
				...conversationMarker(sessionId, { key: host.key, mark: owner }),
				// Where a sender wakes it once it parks, as a holder says for plain pi.
				[WAKE_ENV]: parked.wakeFile(sessionId),
			},
			hints,
			close: (why) => end(sessionId, record, why),
			stamp: (how) => {
				record.ending = how;
				const stamp: SessionStamp = { session: sessionId, how };
				record.bus.emit(SESSION_STAMP_EVENT, stamp);
			},
			reload: () => reload(record),
			restarting: () => {
				const restarting: HostRestarting = { session: sessionId };
				record.bus.emit(HOST_RESTARTING_EVENT, restarting);
			},
			// Its close then keeps its screen's terminal for the wake.
			park: () => {
				record.parking = true;
				return parked.park(sessionId);
			},
		});
		// It reads its mesh as it starts, so nothing left from a park wakes it.
		parked.running(sessionId);
		live.set(sessionId, record);
		return record;
	}

	/**
	 * Release a conversation's session and store, keeping a stopped run for
	 * the next start, and say a conversation that ended itself has ended.
	 */
	async function end(
		sessionId: string,
		record: Live,
		why: string,
	): Promise<void> {
		// The release runs in a frame of its own, so nothing of pi it held,
		// such as its agent, stays in memory while the reap below reads every
		// process's environment.
		await release(sessionId, record, why);
		// A close, not a stop: held but not running, as a failed start or a
		// park's failed stop leaves it, it may still watch calls its park
		// carried, which a close for good stops and a release leaves.
		if (record.ending === "closed")
			parked.closed(sessionId, !released.delete(sessionId));
		await stopping.afterRelease(sessionId, record);
		const events = watched;
		if (record.ending === "closed" && events)
			// Not awaited: the service's answer may close this very conversation, whose close waits on this.
			Promise.resolve()
				.then(() => events.ended(sessionId, why))
				.catch(report);
	}

	/** Let go of a conversation's screen, session and store, and take it off the table. */
	async function release(
		sessionId: string,
		record: Live,
		why: string,
	): Promise<void> {
		record.closing = true;
		// A screen asked about the folder holds a terminal for it, and settles any question still open, whether or not a session came of it.
		if (record.runtime || record.questioned) {
			const screens = options.screens;
			if (record.parking && screens?.parked)
				await screens.parked(sessionId, () => parked.wake(sessionId));
			else await screens?.closed(sessionId, why);
		}
		const agent = record.conversation?.agent;
		if (record.ending !== "closed") agent?.park();
		else if (!record.disposed) await record.runtime?.session.abort();
		record.unsubscribe?.();
		if (record.parking && record.runtime && !record.disposed)
			requests.keepProviders(sessionId, record.runtime.services.modelRuntime);
		if (!record.disposed) await record.runtime?.dispose();
		// Closing signals a running tool and writes no outcome, so the next start reports it cut off.
		try {
			await record.conversation?.close();
		} finally {
			// The host's list keeps a parked conversation, and with it this
			// record, so the record lets go of pi; only its own entry leaves
			// the table, never a newer one under the same id.
			record.runtime = undefined;
			record.conversation = undefined;
			record.unsubscribe = undefined;
			if (live.get(sessionId) === record) {
				live.delete(sessionId);
				tools.forget(sessionId);
				// A parked one stays held, its log with it, until it wakes or is dropped.
				if (!record.parking) logs.release(sessionId);
			}
			// What it held is garbage now: a park lets most of it go, and may collect sooner.
			if (record.parking) quiet.parked();
			else quiet.stirred();
		}
	}

	/** Follow what a conversation's session says: its runs, and the tool calls in them. */
	function heard(sessionId: string, event: string): void {
		tools.heard(sessionId, event);
		publishState(sessionId, event);
	}

	/** Say on the host's list whether a conversation is running, as its runs start and end. */
	function publishState(sessionId: string, event: string): void {
		const state =
			event === "agent_start"
				? "busy"
				: event === "agent_end"
					? "idle"
					: undefined;
		if (!state || host.holds(sessionId) === "parked") return;
		quiet.stirred();
		try {
			host.state(sessionId, state);
		} catch (error) {
			report(error);
		}
	}

	/**
	 * Load a conversation's extensions again once its run is done, as pi's
	 * /reload does. A screen reloads it through its own pi's /reload, since
	 * reloading the session under the screen would leave the old load's
	 * footer and widgets drawing on a load that throws at every read.
	 */
	async function reload(record: Live): Promise<void> {
		const { sessionId } = record.traits;
		const session = view(sessionId, record).runtime.session;
		await session.waitForIdle();
		// A carry ends its run first, so it is idle while it bundles.
		const carried = carryHoldsReload(sessionId);
		if (carried !== undefined) throw new Error(carried);
		const screens = options.screens;
		if (!screens?.reload) return session.reload();
		const before = session.extensionRunner;
		await screens.reload(sessionId);
		// pi's /reload says its failure on the screen, not to its caller; a load whose runner pi never replaced did not reload.
		if (session.extensionRunner === before)
			throw new Error("pi's reload failed, as the conversation's screen says");
	}

	return {
		view(sessionId) {
			const record = live.get(sessionId);
			return record?.runtime ? view(sessionId, record) : undefined;
		},

		watch(events) {
			watched = events;
		},

		viewed() {
			quiet.viewed();
		},

		background() {
			// A warm of a parked conversation is out too, as is a carry.
			let held = warming.inFlight();
			for (const [sessionId, record] of live)
				held +=
					restartEnds(record, shells, host.drains()).length +
					carryEnds(sessionId).length;
			return held;
		},

		holding() {
			const held: string[] = [];
			const warms = warming.inFlight();
			if (warms > 0)
				held.push(`${warms} parked warm${warms === 1 ? "" : "s"} in flight`);
			for (const [sessionId, record] of live)
				for (const what of [
					...restartEnds(record, shells, host.drains()),
					...carryEnds(sessionId),
				])
					held.push(`${sessionId}: ${what}`);
			return held;
		},

		letWakesThrough: (on) => parked.letThrough(on),

		drains: () => host.drains(),

		drain(on) {
			host.drain(on);
			if (!on) parked.release();
			const heavy: string[] = [];
			for (const [sessionId, record] of live)
				for (const what of heavyIn(record)) heavy.push(`${sessionId}: ${what}`);
			return heavy;
		},

		carries: () => shells.keeps,

		async keepCarried() {
			try {
				const moved = await shells.keep();
				if (moved.length > 0)
					report(
						`Kept carried commands through the restart, moving processes ${moved.join(", ")} into the jobs cgroup`,
					);
			} catch (error) {
				// The stop goes on: what wasn't kept is said lost by the next host.
				report(error);
			}
		},

		backgroundOf(sessionId) {
			const record = live.get(sessionId);
			return record ? backgroundIn(record) : 0;
		},

		async prepare(request) {
			const manager =
				request.op === "open"
					? sessions.SessionManager.create(folder(request.cwd))
					: holdKeptHistory(
							sessions.SessionManager.open(adoptable(request.sessionFile)),
							report,
						);
			const sessionId = manager.getSessionId();
			const file = manager.getSessionFile();
			if (!file) throw new Error("pi named no file for the conversation");
			if (held(sessionId, file))
				throw new Error(`Conversation already held: ${sessionId}`);
			const cwd = manager.getCwd();
			const traits: ConversationTraits = {
				sessionId,
				file,
				cwd,
				attended: request.attended,
				...(request.quest ? { quest: request.quest } : {}),
			};
			const launch = { ...options.conversationEnv?.(traits, request) };
			prepared.set(sessionId, { manager, traits, launch });
			return {
				sessionId,
				file,
				cwd,
				...(Object.keys(launch).length > 0 ? { launch } : {}),
			};
		},

		async start(conversation: Prepared, request) {
			const preparing = prepared.get(conversation.sessionId);
			if (!preparing)
				throw new Error(
					`Conversation was not prepared: ${conversation.sessionId}`,
				);
			prepared.delete(conversation.sessionId);
			const { manager, traits, launch } = preparing;
			await begin(traits, manager, launch, request);
		},

		async discard(conversation) {
			prepared.delete(conversation.sessionId);
		},

		async resume(
			entry: RosterEntry,
			woken = false,
			mark?: (phase: ResumePhase) => void,
		) {
			if (host.holds(entry.sessionId) !== undefined)
				throw new Error(`Conversation already running: ${entry.sessionId}`);
			// Before its session starts and takes the carry, so nothing warms twice.
			warming.stop(entry.sessionId);
			// A start resumes one whose marker went with an earlier boot, or
			// names another holder's wake (restsParked keeps those that stand),
			// so it counts idle from its log and parks again within a look.
			if (!woken) clearParked(entry.sessionId);
			if (!existsSync(entry.file))
				throw new Error(
					`Conversation ${entry.sessionId} has lost its session file: ${entry.file}`,
				);
			const manager = holdKeptHistory(
				sessions.SessionManager.open(entry.file),
				report,
			);
			if (manager.getSessionId() !== entry.sessionId)
				throw new Error(
					`${entry.file} now holds conversation ${manager.getSessionId()}, not ${entry.sessionId}`,
				);
			mark?.("log");
			const { sessionId, file, cwd, attended, quest, launch } = entry;
			await begin(
				{ sessionId, file, cwd, attended, ...(quest ? { quest } : {}) },
				manager,
				launch ?? {},
				undefined,
				mark,
				woken ? undefined : turns.take,
			);
			// Only once it runs: a wake that failed leaves its wake file and the
			// calls its park carried watched, and one refused as it began says
			// nothing true now.
			parked.unwatch(sessionId);
			parked.ran(sessionId);
		},

		lost(entry) {
			const running = host.holds(entry.sessionId) !== undefined;
			return !running && sessionFileGone(entry.file);
		},

		resuming(held) {
			turns.hold();
			stopping.resuming(held);
		},

		resumed() {
			stopping.resumed();
			turns.open();
		},

		// Parked by this host key's last process, this boot, and never woken.
		// Building it only to park again a minute later held a start 7 to 13 s
		// a conversation on 13 November. A park waits until it is idle with
		// nothing outstanding, so nothing runs until something asks for it.
		restsParked(entry) {
			const { sessionId } = entry;
			if (host.holds(sessionId) !== undefined) return false;
			if (readParked(sessionId)?.wake !== parked.wakeFile(sessionId))
				return false;
			parked.rests(sessionId);
			logs.hold(sessionId, resolve(entry.file));
			requests.restore(entry);
			return true;
		},

		parkSettled: (sessionId) => parked.settled(sessionId),

		// What restsParked took on, given up to the child that runs it now.
		movedOut(sessionId) {
			parked.unwatch(sessionId);
			warming.stop(sessionId);
			logs.release(sessionId);
			requests.forget(sessionId);
		},

		handsOn(sessionId) {
			// Read as it closes or is dropped, so its carried calls are left to
			// the new holder, here and in what this host's restart keeps.
			released.add(sessionId);
			shells.released(sessionId);
			stopping.handsOn(sessionId);
			host.handsOn(sessionId);
		},

		async dropped(sessionId, why) {
			warming.stop(sessionId);
			logs.release(sessionId);
			requests.forget(sessionId);
			parked.closed(sessionId, !released.delete(sessionId));
			await stopping.dropped(sessionId);
			await options.screens?.closed(sessionId, why);
		},

		async abort(sessionId) {
			const record = live.get(sessionId);
			if (!record) throw new Error(`Conversation is not hosted: ${sessionId}`);
			const session = view(sessionId, record).runtime.session;
			await host.run(sessionId, () => session.abort());
		},
	};
}
