/**
 * Watching a session for the still moment it may park, and parking it.
 *
 * Long because the watch is one closure whose look timer, holds, wakes
 * and step-off between turns share the same state, and splitting it
 * would hand that state across files for every change to when it parks.
 */

import { existsSync, writeFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isHeavy } from "../../host/engine/heavy.ts";
import {
	isParkRefused,
	PARK_REFUSED_EVENT,
} from "../../lib/core/session/host.ts";
import { hosted } from "../../lib/core/session/index.ts";
import { type Holding, whatHolds } from "../../lib/internal/session/free.ts";
import { whyWriting } from "../../lib/internal/session/hand-over.ts";
import {
	AGAIN_ENV,
	BACKGROUND_PARK_AFTER_MS,
	clearEase,
	clearOutlivedParks,
	clearParked,
	EASED_PARK_AFTER_MS,
	flagsLost,
	heldDirectly,
	holderCommand,
	holderRecord,
	isEased,
	isParkNowAsk,
	isRestartAsk,
	noteWake,
	OLD_PARK_AFTER_MS,
	OLD_PI_MS,
	PARK_ASK,
	PARK_ENV,
	PARK_NOW_ASK,
	PARKED_EXIT,
	PARKING,
	type ParkAsk,
	type Parked,
	type Parking,
	parkAfterMs,
	RESTART_ASK,
	readParked,
	SESSION_WOKEN,
	STEERS_ENV,
	sayParked,
	switchOff,
	tellHolderSteers,
	WAKE_ENV,
	whyNotPark,
	writeAwake,
	writeParked,
} from "../../lib/internal/session/park.ts";
import {
	type Desk,
	inSight,
	leaveScreen,
	leftOf,
	machineDesk,
	onNiri,
} from "../../lib/internal/session/park-desktop.ts";
import {
	type HeldWindow,
	heldWindowsOf,
} from "../../lib/internal/session/park-window.ts";
import { askQuit } from "../../lib/internal/session/quit-asker.ts";
import {
	logWritten,
	restartRefused,
} from "../../lib/internal/session/restart-checks.ts";
import {
	onTurnEnd,
	type TurnOver,
} from "../../lib/internal/session/turn-end.ts";
import {
	isCarriedShell,
	withinWatch,
} from "../../lib/internal/shell/carried.ts";
import { writeWhole } from "../../lib/internal/write-whole.ts";
import { findJobHost, type JobHost } from "../../lib/jobs/host.ts";
import { awakeNote } from "./awake.ts";
import { answerParkNow } from "./park-now.ts";
import {
	exitWith,
	niriFocused,
	restartNamed,
	restartWith,
	shownIn,
} from "./restart.ts";
import {
	type FailedPark,
	heldByFailure,
	ParkLeftHalfDone,
	undoPark,
} from "./undo.ts";

/**
 * Why a hosted conversation whose host can't park it stays awake.
 * Parking plain pi ends the whole process, which in a host is every
 * conversation it runs, so only a host that parks one conversation
 * (`Host.park`) lets it sleep.
 */
export const HOST_PARKS = "its host parks it";

/**
 * What every child host since 19 November is started with, naming its
 * slot (host/service/child.ts, `childSlot`); a shared host has none.
 */
const CHILD_KEY_ENV = "PI_HOST_CHILD_KEY";

/**
 * Tell the watch `current` answers of each turn's end, through the
 * session's one turn-end listener, saying whether pi asks the model
 * again for what the turn's tools answered.
 */
export function heedTurnEnds(
	pi: ExtensionAPI,
	current: () => Pick<Watch, "turnEnded"> | undefined,
): void {
	onTurnEnd(pi, (turn) => {
		current()?.turnEnded(asksAgain(turn));
	});
}

/**
 * Whether pi asks the model again after `turn` for what its tools
 * answered: they ran, it went as asked, and the listener said the run
 * goes on. A run stepped off after its last turn, as a tool that ends
 * the run makes it, would be woken at the drain's end with nothing to
 * carry on. A turn with no tools that pi follows with another carries a
 * queued message, so it's only looked at, as is a turn that can't say
 * whether the run goes on: neither steps off between turns.
 */
function asksAgain(turn: TurnOver): boolean {
	return (
		turn.toolResults.length > 0 &&
		turn.outcome === "completed" &&
		turn.endsRun === false
	);
}

/** The host this conversation runs in, when that host can park it alone. */
function parkingHost(): { park(sessionId: string): void } | undefined {
	const host = hosted();
	const park = host?.park;
	return host && park ? { park: (id) => park.call(host, id) } : undefined;
}

/**
 * The jobs that keep a conversation awake, named where its job host can
 * say which. Where its park would carry its bash calls (`carried`), a
 * call out within its watch holds it no longer; one past its time limit
 * or a day old, whose watch would wake it at once, still does, as do any
 * other job and an end not yet said. So does a heavy run (`isHeavy`): a
 * drain lists heavy runs only from conversations awake, so a parked
 * one's would be cut by a drained restart. A job host from before
 * `holds` counts every pending job.
 */
function jobsHolding(
	jobs: JobHost | undefined,
	carried: boolean,
	now: number,
): Pick<Holding, "jobs" | "heldBy"> {
	const pending = jobs?.pending?.() ?? 0;
	if (!jobs?.holds || !jobs.running) return { jobs: pending };
	const held = jobs.holds(
		carried
			? (work) => isCarriedShell(work) && withinWatch(work, now)
			: () => false,
	);
	const heavy = jobs
		.running()
		.filter(
			(job) => isHeavy(job.label) && !held.some((hold) => hold.id === job.id),
		);
	const heldBy = [...held, ...heavy];
	const unsaid = Math.max(0, pending - jobs.running().length);
	return {
		jobs: heldBy.length + unsaid,
		...(heldBy.length > 0 && unsaid === 0 ? { heldBy } : {}),
	};
}

/**
 * Whether this conversation's host is a background one, whose key ends
 * in its kind as `realm-background`, and parks it alone. Never on macOS:
 * on 21 November four Mac holders were lost as their sessions parked,
 * so a Mac keeps the usual limit until its holder survives a park.
 */
function inBackgroundHost(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		platform !== "darwin" &&
		parkingHost() !== undefined &&
		hosted()?.key.endsWith("-background") === true
	);
}

/** How often a session asks itself whether it may park. */
export const LOOK_EVERY_MS = 60_000;

/** What parking is given of pi: its bus. */
export interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** The parts of a context parking reads and acts through. */
export type Parkable = Pick<
	ExtensionContext,
	| "hasUI"
	| "sessionManager"
	| "isIdle"
	| "hasPendingMessages"
	| "shutdown"
	| "cwd"
> & { readonly ui: Pick<ExtensionContext["ui"], "getEditorText"> };

/**
 * Whether this session may ever park: one its person sees, not a
 * subagent, and held by a holder that said where it watches for its
 * wake (`MYCELIUM_WAKE`). A pi with no holder that parked would just end.
 * In a host, only one that parks a conversation alone, which says where
 * it watches for the wake in the conversation's own environment.
 */
export function mayPark(
	ctx: Pick<ExtensionContext, "hasUI">,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (hosted() && !parkingHost()) return false;
	return isPersons(ctx, env) && Boolean(env[WAKE_ENV]);
}

/** Whether a session is one its person sees, rather than a subagent. */
function isPersons(
	ctx: Pick<ExtensionContext, "hasUI">,
	env: NodeJS.ProcessEnv,
): boolean {
	if (!ctx.hasUI) return false;
	return !(env.SUBAGENT_SUPERVISOR === "1" || env.SUBAGENT_RUN_ID);
}

/**
 * Say why a person's session that may never park stays awake: its host
 * parks it, or no holder said where it watches for a wake. Answers whether it said so, for the
 * caller to clear as the session ends.
 */
export function noteNeverParks(
	ctx: Pick<ExtensionContext, "hasUI" | "sessionManager">,
	env: NodeJS.ProcessEnv = process.env,
	folder?: string,
	now: () => number = Date.now,
): boolean {
	if (!isPersons(ctx, env)) return false;
	const inHost = hosted() !== undefined && !parkingHost();
	if (!inHost && env[WAKE_ENV]) return false;
	try {
		writeAwake(
			{
				session: ctx.sessionManager.getSessionId(),
				why: inHost ? HOST_PARKS : "no holder would wake it",
				since: new Date(now()).toISOString(),
			},
			folder,
		);
		return true;
	} catch {
		// A park folder that can't be written says nothing; the session runs.
		return false;
	}
}

/** A session watched for parking. */
export interface Watch {
	/** Something happened in the session: count idle from now. */
	stirred(): void;
	/** A prompt for its person opened or closed. */
	prompting(open: boolean): void;
	/** Its person pressed a key, clicked or scrolled in its window. */
	present(): void;
	/** Look now whether it may park, and park it if so; answers why not. */
	look(): string | undefined;
	/**
	 * A turn ended, between its answer and the next ask of the model. While
	 * its host drains or its code is stale and no window views it, a run
	 * under way holds it no longer: it parks here, its wake written at once,
	 * and durable carries the run on in the next start, on current code.
	 * `asksAgain` ({@link heedTurnEnds}), pi asks the model again; a turn
	 * that ended the run is only looked at, since pi may not yet read as
	 * idle as it ends, and the next look parks it once it does. The host
	 * parks it just after this returns, so the next request may already
	 * have gone out. That relies on durable keeping an answer only once
	 * it's whole, so the cut-off request is asked again in the next start;
	 * no test here drives that race. Answers why not.
	 */
	turnEnded(asksAgain: boolean): string | undefined;
	/**
	 * End now for its holder to start it again at once on `sessionFile`,
	 * if nothing holds it; answers why not. A rollover asks it on the bus
	 * ({@link RESTART_ASK}), and the watch answers there too. `asked`, its
	 * person asked for it, so their being at its window doesn't hold it.
	 */
	restartInto(sessionFile: string, asked?: boolean): string | undefined;
	/**
	 * Park now, as its person asked from outside its window, however
	 * briefly it has been idle, if nothing else holds it; answers why not.
	 * The mesh asks it on the bus ({@link PARK_NOW_ASK}), and the watch
	 * answers there too.
	 */
	parkNow(): string | undefined;
	/**
	 * Whether this watch ended pi's process for its holder to start again,
	 * parked or restarting, rather than a host's conversation.
	 */
	endedItsProcess(): boolean;
	/**
	 * Stop watching, as the session ends. An ask to park soon stays: a
	 * host's stop and a reload both go on as the same conversation, and an
	 * ask nobody answers lapses on its own.
	 */
	stop(): void;
}

/** What a watch is given, beyond the session. */
export interface WatchOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly switchPath?: string;
	readonly folder?: string;
	readonly now?: () => number;
	/** pi's own arguments, which a holder naming no restart runs again. */
	readonly args?: readonly string[];
	/** Set the code pi exits with, once it exits. */
	readonly exitWith?: (code: number) => void;
	/** Look on a clock; false for tests that look by hand. */
	readonly clock?: boolean;
	/** This process, which its holder's record must name to park. */
	readonly pid?: number;
	/** The operating system it runs on, which a background limit weighs. */
	readonly platform?: NodeJS.Platform;
	/** When this process started, by `now`'s clock, which an old one parks sooner by. */
	readonly startedAt?: number;
	/**
	 * The app id of the window the desktop has focused, or null when it
	 * can't be told; asked only as a restart is weighed.
	 */
	readonly focusedWindow?: () => string | null;
	/**
	 * Start this process again in place on `sessionFile`, once pi exits,
	 * running `fallback` where it can't be.
	 */
	readonly restartWith?: (sessionFile: string, fallback: () => void) => void;
	/** Set the code pi exits with, from within its exit. */
	readonly setExitCode?: (code: number) => void;
	/** Say a line in its window, from within its exit; stdout unless given. */
	readonly say?: (line: string) => void;
	/**
	 * The desktop its window is closed through as it parks, under niri;
	 * this machine's unless given.
	 */
	readonly desk?: Desk;
}

/**
 * How long since its person was last at a window before a restart may
 * blank it, as WCJQSG set on 10 November [e7c3cbbf]: never the window
 * Joel has focused, nor one he was in within ten minutes.
 */
export const UNWATCHED_MS = 10 * 60_000;

/**
 * Tell a holder that watches steers (`file`, from {@link STEERS_ENV})
 * where this session's land and which wake it, as the mesh said while
 * it parked. A holder told nothing wakes it for a steer only as a
 * running peer asks, within a minute, so a write that fails doesn't
 * hold up the park.
 */
function tellSteers(file: string, parking: Parking): void {
	if (file === "") return;
	try {
		tellHolderSteers(file, parking.steers);
	} catch {
		// Untold, its holder wakes it as a running peer asks: a minute on.
	}
}

/**
 * When the session last did anything, as its log says: the newest
 * message on its branch. A mesh note is no message, as it stirs nothing
 * once the session runs either.
 */
function lastMessageAt(ctx: Parkable): number | undefined {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let at = branch.length - 1; at >= 0; at -= 1) {
		const entry = branch[at];
		if (entry?.type !== "message") continue;
		const when = Date.parse(entry.timestamp);
		return Number.isNaN(when) ? undefined : when;
	}
	return undefined;
}

/**
 * Watch this session, clearing any marker an earlier park left, and any
 * marker on the machine that its boot outlived.
 */
export function watch(
	ctx: Parkable,
	bus: Bus,
	options: WatchOptions = {},
): Watch {
	const now = options.now ?? Date.now;
	const startedAt = options.startedAt ?? now() - process.uptime() * 1000;
	const env = options.env ?? process.env;
	const wake = env[WAKE_ENV] ?? "";
	const again = env[AGAIN_ENV] ?? "";
	const args = options.args ?? process.argv.slice(2);
	const session = ctx.sessionManager.getSessionId();
	const folder = options.folder;
	// Started again, it is parked no more; its holder clears the wake.
	const marker = readParked(session, folder);
	const woke = marker !== undefined;
	// Kept for a day, so how often a park rule wakes its sessions can be
	// counted, and how long each rested.
	if (marker) {
		try {
			const host = hosted()?.key;
			noteWake(
				session,
				{
					parkedAt: marker.parkedAt,
					afterMs: marker.afterMs,
					goesOn: marker.goesOn,
					...(host ? { host } : {}),
				},
				folder,
				now,
			);
		} catch {
			// A wake it couldn't note is one fewer counted, never a start
			// that fails with its marker still saying it is parked.
		}
	}
	clearParked(session, folder);
	// Woken, it was asked to park soon and did; the node asks again should
	// its machine still read over.
	if (woke) clearEase(session, folder);
	// Markers a reboot outlived name sessions no holder will wake.
	clearOutlivedParks(folder);
	if (woke) bus.emit(SESSION_WOKEN, { session });
	// Idle counts from its log, not from this start: every install that
	// moves reloads every session, and on 6 November installs moved about
	// every half hour, so a clock started here never reached its hour. A
	// session just woken counts from now, or a key that woke it, with
	// nothing sent yet, would see it park again within a minute.
	let last = woke ? now() : Math.min(now(), lastMessageAt(ctx) ?? now());
	let prompts = 0;
	let parked = false;
	// Ended pi's own process, as a host's conversation never does.
	let endedProcess = false;
	let failed: FailedPark | undefined;
	// The windows the park under way closed, for a take-back to say.
	let closedWindows = 0;
	// Its person was last at its window, as far as this process saw.
	let presentAt = Number.NEGATIVE_INFINITY;
	const holding = (): Holding => ({
		agentIdle: ctx.isIdle(),
		pendingMessages: ctx.hasPendingMessages(),
		...jobsHolding(
			findJobHost(bus),
			inBackgroundHost(options.platform) &&
				hosted()?.carries?.(session) === true &&
				hosted()?.viewed?.(session) !== true,
			now(),
		),
		prompting: prompts > 0,
		typed: ctx.ui.getEditorText().trim() !== "",
	});
	// The windows its holder shows it in, which close as it parks: none
	// off niri, and none in a host, which keeps its conversations' windows.
	const closable = (): readonly HeldWindow[] => {
		if (!onNiri(env) || parkingHost()) return [];
		return heldWindowsOf(holderRecord(wake)) ?? [];
	};
	const desk = (): Desk => options.desk ?? machineDesk(folder);
	const unheld = (): string | undefined => {
		if (wake === "") return "no holder would wake it";
		// A host holds its conversations itself, in its own process.
		if (parkingHost()) return undefined;
		if (!heldDirectly(wake, options.pid ?? process.pid)) {
			return "its holder runs it through another program";
		}
		return undefined;
	};
	// How long it waits idle before it parks: not at all while its host
	// drains for a restart, since on 16 November the background host's 17
	// conversations took turns that overlapped for over an hour, and no
	// moment came with none running. Nor while its host's code is stale,
	// since on 22 November 15 children ran host code 34 hours old, and its
	// next wake starts it on current code. PI_PARK=off keeps it awake still.
	const dueAfterMs = (): number | undefined => {
		const usual = parkAfterMs(session, options.env, options.switchPath);
		if (env[PARK_ENV] === "off") return usual;
		if (parkingHost()) {
			if (hosted()?.draining?.(session) === true) return 0;
			if (hosted()?.rolling?.(session) === true) return 0;
			if (!inBackgroundHost(options.platform)) return usual;
			// One a window views may be read by the person, whose next key
			// would wait out its wake, so it waits as an attended one does,
			// asked to ease or not.
			if (hosted()?.viewed?.(session) === true) return usual;
			// Asked to ease while its machine reads over, nobody watching, it
			// parks two minutes idle, unless the switch says `off`.
			if (!switchOff(options.switchPath) && isEased(session, folder, now()))
				return EASED_PARK_AFTER_MS;
			if (usual === undefined) return usual;
			// Nobody watches a background conversation wake, and what it holds
			// goes as it parks: its own process in a child, its share of the
			// host's in the host.
			return Math.min(usual, BACKGROUND_PARK_AFTER_MS);
		}
		if (usual === undefined) return usual;
		// A plain pi parks sooner once its process is old, since its wake
		// starts a fresh one.
		return now() - startedAt >= OLD_PI_MS
			? Math.min(usual, OLD_PARK_AFTER_MS)
			: usual;
	};
	const end = () => {
		parked = true;
		// Parked, it has done what an ask to park soon asked.
		clearEase(session, folder);
		// A host parks this conversation alone, keeping its window and wake.
		const host = parkingHost();
		if (host) {
			host.park(session);
			return;
		}
		endedProcess = true;
		sayParked(env, options.pid ?? process.pid);
		(options.exitWith ?? exitWith)(PARKED_EXIT);
		askQuit("park-workflow, parking");
		void ctx.shutdown();
	};
	// Whether a run under way may step off at a turn's end: its host drains
	// or its code is stale, so the start that wakes it runs current code,
	// and no window views it, where the person would see the run stop; and
	// its host would hold the wake it leaves, rather than wake it here at
	// once, as past a drain's ceiling. Answers why not.
	const moving = (): boolean => {
		const host = hosted();
		return (
			host?.draining?.(session) === true || host?.rolling?.(session) === true
		);
	};
	const keepsRunning = (): string | undefined => {
		const host = hosted();
		if (!(host && parkingHost())) return "no host parks it mid-run";
		if (host.viewed?.(session) === true) return "a window views its run";
		if (!moving()) return "its host neither drains nor rolls";
		// A child older than wakeHeld, its watch reloaded onto this one,
		// holds every wake while its host drains and none while it only
		// rolls: its drain says, since a child never passes a ceiling. A
		// shared host does, letting wakes through while its drain stands,
		// so one older than wakeHeld keeps its runs going.
		const held = host.wakeHeld
			? host.wakeHeld(session)
			: Boolean(env[CHILD_KEY_ENV]) && host.drains?.() === true;
		return held ? undefined : "its host would wake it again here at once";
	};
	// The person's Park counts no idle time, only what holds it, so long
	// as parking is on at all.
	const askedAfterMs = (): number | undefined =>
		dueAfterMs() === undefined ? undefined : 0;
	// A check answers what would refuse a park once the run settles, and
	// parks nothing, writing nothing its holder would read.
	const decide = (
		goesOn = false,
		asked = false,
		check = false,
	): string | undefined => {
		if (parked) return "parking already";
		// A drain or a roll waits on this park to restart its host, so a
		// failure holds only the clock's own tries.
		const stuck = asked || moving() ? undefined : heldByFailure(failed, now());
		if (stuck !== undefined) return stuck;
		// A watch begun before a host was installed still never ends it.
		if (hosted() && !parkingHost()) return HOST_PARKS;
		const ask: ParkAsk = {
			session,
			refusals: [],
			...(goesOn ? { goesOn: true } : {}),
		};
		const afterMs = asked ? askedAfterMs() : dueAfterMs();
		// Others are asked only once it is due, since asking reads the board.
		if (afterMs !== undefined && now() - last >= afterMs) {
			bus.emit(PARK_ASK, ask);
		}
		const why = whyNotPark({
			...holding(),
			// Between turns, the run holds nothing the next start loses; a
			// check is asked of a run about to be stopped.
			...(goesOn || check ? { agentIdle: true } : {}),
			idleMs: now() - last,
			afterMs,
			refusals: ask.refusals,
		});
		if (why !== undefined) return why;
		const away = unheld();
		if (away !== undefined) return away;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
		// Naming its next start tells its holder, so a check asks only what
		// refuses it for certain; its first answer has yet to write its log.
		if (check) {
			return parkingHost()
				? undefined
				: restartRefused(again, args, session, sessionFile);
		}
		// A host wakes it from its log as it resumes it; plain pi's holder
		// has to be told how to start it again.
		const unnamed = parkingHost()
			? logWritten(sessionFile)
			: restartNamed(again, args, session, sessionFile, env);
		if (unnamed !== undefined) return unnamed;
		// Asked last, since it reads the screen: a window Joel is at or can
		// see keeps its session awake rather than closing.
		// Its person asking is the moment, as a restart they ask for is,
		// though leaving the screen still keeps a window they clicked into.
		const windows = closable();
		const seen = asked ? undefined : inSight(windows, desk());
		if (seen !== undefined) return seen;
		// Woken as it parks: a drain or a stale host holds the wake until it
		// ends, and the next start carries the run on. Written before the
		// park, since the host reads a wake written ahead of its watch.
		if (goesOn) {
			try {
				writeWhole(
					wake,
					JSON.stringify({ session, at: new Date(now()).toISOString() }),
				);
			} catch (error) {
				// Unwoken, it would rest mid-run until a message came, so it
				// stays awake and its run goes on here.
				return `its wake couldn't be written: ${whyWriting(wake, error)}`;
			}
		}
		try {
			mark(goesOn, afterMs, sessionFile, windows);
			end();
		} catch (error) {
			takeBack(error);
		}
		return undefined;
	};
	// Still up, it reads as awake again, and a later park may go.
	const takeBack = (error: unknown): never => {
		const saidToHolder = endedProcess;
		parked = false;
		endedProcess = false;
		const pid = options.pid ?? process.pid;
		const windowsClosed = closedWindows;
		closedWindows = 0;
		const half = { session, folder, wake, windowsClosed };
		try {
			return undoPark(error, { ...half, saidToHolder, env, pid, bus });
		} catch (thrown) {
			// What it threw, so the clock's hold says any part left standing.
			failed = { at: now(), error: thrown };
			throw thrown;
		}
	};
	// Say it parks, to the mesh and in its marker, before its holder ends it.
	const mark = (
		goesOn: boolean,
		afterMs: number | undefined,
		sessionFile: string,
		windows: readonly HeldWindow[],
	): void => {
		closedWindows = 0;
		const parking: Parking = { session, addresses: [], wake };
		bus.emit(PARKING, parking);
		// A host watches its conversations' inboxes itself (host/engine).
		if (!parkingHost()) tellSteers(env[STEERS_ENV] ?? "", parking);
		const marker: Parked = {
			session,
			sessionFile,
			cwd: ctx.cwd,
			addresses: parking.addresses,
			...(parking.quest ? { quest: parking.quest } : {}),
			parkedAt: new Date(now()).toISOString(),
			// What it parked under, so a drain's wakes aren't the rule's churn.
			...(afterMs === undefined ? {} : { afterMs }),
			pid: process.pid,
			wake,
			...(goesOn ? { goesOn: true } : {}),
		};
		writeParked(marker, folder);
		// Its holder outlives the window; whatever stays open stays parked,
		// its marker saying why, so a sleeper's window still there explains
		// itself.
		if (windows.length > 0) {
			const left = leftOf(leaveScreen(session, windows, desk()));
			closedWindows = left.closed.length;
			writeParked({ ...marker, windows: left }, folder);
		}
	};
	// Whether its person may be looking: the blank a restart leaves for
	// a few seconds is a bump only where nobody sees it.
	const watched = (): string | undefined => {
		if (now() - presentAt < UNWATCHED_MS) {
			return "its person was at its window in the last ten minutes";
		}
		const windows = shownIn(wake);
		if (windows === undefined) return "its holder doesn't say where it shows";
		if (windows.length === 0) return undefined;
		const focused = (options.focusedWindow ?? niriFocused)();
		if (focused === null)
			return "the desktop can't say which window is focused";
		if (windows.some((id) => id === "" || id === focused)) {
			return "its window may be the one focused";
		}
		return undefined;
	};
	// Not a park: no marker, since it starts again at once, in place, or
	// else through its holder, on the wake it writes itself.
	const restartInto = (fresh: string, asked = false): string | undefined => {
		if (parked) return "parking already";
		if (hosted()) return HOST_PARKS;
		if (parkAfterMs(session, options.env, options.switchPath) === undefined) {
			return "parking is off";
		}
		const ask: ParkAsk = { session, refusals: [], restart: true };
		bus.emit(PARK_ASK, ask);
		const why = whatHolds(holding()) ?? ask.refusals[0] ?? unheld();
		if (why !== undefined) return why;
		if (!existsSync(fresh)) return "its fresh log isn't written";
		// A holder that takes no command would run the one that opened the
		// log just left.
		if (again === "") return "its holder would start it on the log it left";
		const lost = flagsLost(args);
		if (lost.length > 0) return `starting again would drop ${lost.join(", ")}`;
		// Its person asking is the settled moment a restart waits for.
		const seen = asked ? undefined : watched();
		if (seen !== undefined) return seen;
		// Named before pi ends, as a park names it, so whatever starts it
		// next opens the fresh log: one that couldn't be named would wake
		// at a key on the log it left, or as a new conversation, so it
		// stays. The holder reads it only once its program ends, so a
		// restart in place still shows it no exit.
		try {
			writeWhole(again, JSON.stringify(holderCommand(fresh, args, env)));
		} catch (error) {
			return `its holder couldn't be told how to start it again: ${whyWriting(again, error)}`;
		}
		const throughHolder = () => {
			// Its holder starts the named command at once when woken. Unwoken,
			// the window stays parked and a key starts it, still on the fresh
			// log, as the window says.
			try {
				writeFileSync(
					wake,
					`${JSON.stringify({ session, restart: fresh, at: new Date(now()).toISOString() })}\n`,
				);
			} catch (error) {
				(
					options.say ??
					((line: string) => process.stdout.write(`\r\n${line}\r\n`))
				)(
					`It stays parked until a key starts it again, since its holder couldn't be woken: ${whyWriting(wake, error)}.`,
				);
			}
			const setCode =
				options.setExitCode ??
				((code: number) => {
					process.exitCode = code;
				});
			setCode(PARKED_EXIT);
		};
		parked = true;
		endedProcess = true;
		// Said now, so a shutdown that hangs and ends by a signal before
		// the exit, or an execve that aborts, still leaves its holder a
		// park, as a park says it. Replaced in place, the pi it becomes
		// takes it back as it loads (takeBackRestartPark), since its holder
		// saw no exit and never clears it.
		sayParked(env, options.pid ?? process.pid);
		(options.restartWith ?? restartWith)(fresh, throughHolder);
		askQuit("park-workflow, restarting onto fresh code");
		void ctx.shutdown();
		return undefined;
	};
	const parkNow = (): string | undefined => {
		const why = decide(false, true);
		note(why);
		return why;
	};
	const unparked = bus.on(PARK_NOW_ASK, (data) => {
		if (!isParkNowAsk(data) || data.session !== session) return;
		answerParkNow(data, () => decide(false, true, true), parkNow);
	});
	const unrefused = bus.on(PARK_REFUSED_EVENT, (data) => {
		if (!isParkRefused(data) || data.session !== session || !parked) return;
		try {
			takeBack(new Error(data.why));
		} catch (error) {
			// The person's Park answered parked, so its note says at once why
			// it runs on, rather than at the clock's next look.
			note(heldByFailure(failed, now(), moving()));
			// Its host already said why it runs on; pi's bus says what a
			// listener throws, so only what may still read parked goes there.
			if (error instanceof ParkLeftHalfDone && error.readsParked) throw error;
		}
	});
	const unasked = bus.on(RESTART_ASK, (data) => {
		if (!isRestartAsk(data) || data.session !== session) return;
		const why = restartInto(data.sessionFile, data.asked === true);
		if (why === undefined) data.restarting = true;
		else data.why = why;
	});
	const note = awakeNote(session, folder, now);
	const look = (): string | undefined => {
		const why = decide();
		note(why);
		return why;
	};
	const turnEnded = (asksAgain: boolean): string | undefined => {
		if (!asksAgain || ctx.isIdle()) return look();
		// Not noted: a look between turns says why it waits, as before.
		const running = keepsRunning();
		if (running !== undefined) return running;
		const why = decide(true);
		note(why);
		return why;
	};
	const clock =
		options.clock === false
			? undefined
			: setInterval(() => {
					try {
						look();
					} catch {
						// A session switched out from under its clock is no longer
						// this one's to park; the next start watches afresh.
					}
				}, LOOK_EVERY_MS);
	clock?.unref?.();
	return {
		stirred() {
			last = now();
		},
		prompting(open) {
			prompts = Math.max(0, prompts + (open ? 1 : -1));
			last = now();
		},
		present() {
			presentAt = now();
		},
		look,
		turnEnded,
		restartInto,
		parkNow,
		endedItsProcess: () => endedProcess,
		stop() {
			unasked();
			unparked();
			unrefused();
			clearInterval(clock);
			note(undefined);
		},
	};
}
