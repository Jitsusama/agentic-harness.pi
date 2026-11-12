/**
 * Watching a session for the still moment it may park, and parking it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hosted } from "../../lib/core/session/index.ts";
import { type Holding, whatHolds } from "../../lib/internal/session/free.ts";
import {
	AGAIN_ENV,
	clearAwake,
	clearOutlivedParks,
	clearParked,
	flagsLost,
	heldDirectly,
	holderCommand,
	holderRecord,
	isRestartAsk,
	opensOnlyItself,
	PARK_ASK,
	PARKED_EXIT,
	PARKING,
	type ParkAsk,
	type Parking,
	parkAfterMs,
	RESTART_ASK,
	readParked,
	restartCommand,
	SESSION_WOKEN,
	WAKE_ENV,
	whyNotPark,
	writeAwake,
	writeParked,
} from "../../lib/internal/session/park.ts";
import { findJobHost } from "../../lib/jobs/host.ts";

/**
 * Why a hosted conversation whose host can't park it stays awake.
 * Parking plain pi ends the whole process, which in a host is every
 * conversation it runs, so only a host that parks one conversation
 * (`Host.park`) lets it sleep.
 */
export const HOST_PARKS = "its host parks it";

/** The host this conversation runs in, when that host can park it alone. */
function parkingHost(): { park(sessionId: string): void } | undefined {
	const host = hosted();
	const park = host?.park;
	return host && park ? { park: (id) => park.call(host, id) } : undefined;
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
	 * End now for its holder to start it again at once on `sessionFile`,
	 * if nothing holds it; answers why not. A rollover asks it on the bus
	 * ({@link RESTART_ASK}), and the watch answers there too. `asked`, its
	 * person asked for it, so their being at its window doesn't hold it.
	 */
	restartInto(sessionFile: string, asked?: boolean): string | undefined;
	/** Stop watching, as the session ends. */
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
	/** Set the code pi exits with, and the line it leaves, once it exits. */
	readonly exitWith?: (code: number, line: string) => void;
	/** Look on a clock; false for tests that look by hand. */
	readonly clock?: boolean;
	/** This process, which its holder's record must name to park. */
	readonly pid?: number;
	/**
	 * The app id of the window the desktop has focused, or null when it
	 * can't be told; asked only as a restart is weighed.
	 */
	readonly focusedWindow?: () => string | null;
	/** Start this process again in place on `sessionFile`, once pi exits. */
	readonly restartWith?: (sessionFile: string, fallback: () => void) => void;
	/** Set the code pi exits with, from within its exit. */
	readonly setExitCode?: (code: number) => void;
}

/**
 * How long since its person was last at a window before a restart may
 * blank it, as WCJQSG set on 10 November [e7c3cbbf]: never the window
 * Joel has focused, nor one he was in within ten minutes.
 */
export const UNWATCHED_MS = 10 * 60_000;

/** What a window shows once its session has parked. */
export const PARKED_LINE =
	"Parked while idle, holding no memory. A key or a message wakes it.";

/** What a window shows as its session starts again on a fresh log. */
export const RESTART_LINE =
	"Starting again on its fresh log, to give back what the old one held.";

/** The variables a spawn handed this pi for its first start alone. */
const FIRST_START_ONLY = [
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"QUEST_WORKFLOW_AUTOLOAD_ID",
	"QUEST_WORKFLOW_FIRST_WORDS",
];

/**
 * Once pi exits, replace this process with a fresh pi on `sessionFile`,
 * in place: the same pid, terminal and holder, so the holder never sees
 * an exit and says nothing of a park. One that can't be replaced runs
 * `fallback`, which has its holder start it again instead.
 */
function restartWith(sessionFile: string, fallback: () => void): void {
	process.once("exit", () => {
		process.stdout.write(`\r\n${RESTART_LINE}\r\n`);
		const env = { ...process.env };
		for (const name of FIRST_START_ONLY) delete env[name];
		const [script = ""] = process.argv.slice(1);
		try {
			// Node calls execve experimental and would print so in the window.
			process.removeAllListeners("warning");
			process.execve?.(
				process.execPath,
				[
					process.execPath,
					...process.execArgv,
					script,
					...restartCommand(sessionFile, process.argv.slice(2)).slice(1),
				],
				env,
			);
		} catch {
			// Not replaced: its holder starts it again instead, below.
		}
		fallback();
	});
}

/**
 * The app id of the window niri has focused, or null when niri can't be
 * asked, as off Linux or outside niri.
 */
function niriFocused(): string | null {
	try {
		const out = execFileSync("niri", ["msg", "--json", "focused-window"], {
			encoding: "utf8",
			timeout: 2_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const window: unknown = JSON.parse(out);
		if (window === null) return "";
		if (typeof window !== "object" || !("app_id" in window)) return null;
		return typeof window.app_id === "string" ? window.app_id : "";
	} catch {
		// No niri to ask, or one that didn't answer: focus can't be told.
		return null;
	}
}

/** The app ids of the windows a holder's record says show this session. */
function shownIn(wake: string): string[] | undefined {
	const record = holderRecord(wake);
	// A record missing or half written can't say where it shows.
	if (!record) return undefined;
	const windows = "windows" in record ? record.windows : [];
	if (!Array.isArray(windows)) return undefined;
	return windows.map((window: unknown) =>
		typeof window === "object" &&
		window !== null &&
		"app_id" in window &&
		typeof window.app_id === "string"
			? window.app_id
			: "",
	);
}

/**
 * Say to the process that, whatever pi exits with, it exits with this,
 * leaving `line` in its window.
 */
function exitWith(code: number, line: string): void {
	// pi ends a quit with process.exit(0); an exit listener's code wins.
	process.once("exit", () => {
		process.exitCode = code;
		// The window stays with its holder, so it says why it is quiet.
		process.stdout.write(`\r\n${line}\r\n`);
	});
}

/**
 * Make sure its holder wakes this session into itself: by naming the
 * command that opens its log, or, for a holder that takes none, by the
 * command it runs already opening it. Answers why not otherwise.
 */
function restartNamed(
	again: string,
	args: readonly string[],
	session: string,
	sessionFile: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const unwritten = logWritten(sessionFile);
	if (unwritten !== undefined) return unwritten;
	if (again === "") {
		return opensOnlyItself(args, session, sessionFile)
			? undefined
			: "its holder would start it as a new session";
	}
	const lost = flagsLost(args);
	if (lost.length > 0) return `starting again would drop ${lost.join(", ")}`;
	try {
		writeFileSync(again, JSON.stringify(holderCommand(sessionFile, args, env)));
		return undefined;
	} catch {
		return "its holder couldn't be told how to start it again";
	}
}

/**
 * Why a session can't start again from its log, if it can't: pi writes a
 * log at its first answer, so one never asked anything would wake as a
 * new session, under another address.
 */
function logWritten(sessionFile: string): string | undefined {
	if (sessionFile === "") return "it has no log to start again from";
	if (!existsSync(sessionFile)) return "its log isn't written yet";
	return undefined;
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
	const env = options.env ?? process.env;
	const wake = env[WAKE_ENV] ?? "";
	const again = env[AGAIN_ENV] ?? "";
	const args = options.args ?? process.argv.slice(2);
	const session = ctx.sessionManager.getSessionId();
	const folder = options.folder;
	// Started again, it is parked no more; its holder clears the wake.
	const woke = readParked(session, folder) !== undefined;
	clearParked(session, folder);
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
	// Its person was last at its window, as far as this process saw.
	let presentAt = Number.NEGATIVE_INFINITY;
	const holding = (): Holding => ({
		agentIdle: ctx.isIdle(),
		pendingMessages: ctx.hasPendingMessages(),
		jobs: findJobHost(bus)?.pending?.() ?? 0,
		prompting: prompts > 0,
		typed: ctx.ui.getEditorText().trim() !== "",
	});
	const unheld = (): string | undefined => {
		if (wake === "") return "no holder would wake it";
		// A host holds its conversations itself, in its own process.
		if (parkingHost()) return undefined;
		if (!heldDirectly(wake, options.pid ?? process.pid)) {
			return "its holder runs it through another program";
		}
		return undefined;
	};
	const end = (line: string) => {
		parked = true;
		// A host parks this conversation alone, keeping its window and wake.
		const host = parkingHost();
		if (host) {
			host.park(session);
			return;
		}
		(options.exitWith ?? exitWith)(PARKED_EXIT, line);
		void ctx.shutdown();
	};
	const decide = (): string | undefined => {
		if (parked) return "parking already";
		// A watch begun before a host was installed still never ends it.
		if (hosted() && !parkingHost()) return HOST_PARKS;
		const ask: ParkAsk = { session, refusals: [] };
		const afterMs = parkAfterMs(session, options.env, options.switchPath);
		// Others are asked only once it is due, since asking reads the board.
		if (afterMs !== undefined && now() - last >= afterMs) {
			bus.emit(PARK_ASK, ask);
		}
		const why = whyNotPark({
			...holding(),
			idleMs: now() - last,
			afterMs,
			refusals: ask.refusals,
		});
		if (why !== undefined) return why;
		const away = unheld();
		if (away !== undefined) return away;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
		// A host wakes it from its log as it resumes it; plain pi's holder
		// has to be told how to start it again.
		const unnamed = parkingHost()
			? logWritten(sessionFile)
			: restartNamed(again, args, session, sessionFile, env);
		if (unnamed !== undefined) return unnamed;
		const parking: Parking = { session, addresses: [], wake };
		bus.emit(PARKING, parking);
		writeParked(
			{
				session,
				sessionFile,
				cwd: ctx.cwd,
				addresses: parking.addresses,
				...(parking.quest ? { quest: parking.quest } : {}),
				parkedAt: new Date(now()).toISOString(),
				pid: process.pid,
				wake,
			},
			folder,
		);
		end(PARKED_LINE);
		return undefined;
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
		const throughHolder = () => {
			try {
				writeFileSync(again, JSON.stringify(holderCommand(fresh, args, env)));
				writeFileSync(
					wake,
					`${JSON.stringify({ session, restart: fresh, at: new Date(now()).toISOString() })}\n`,
				);
			} catch {
				// Its holder keeps the window parked, and a key wakes it on the
				// command it ran, which brings back the log it left.
			}
			const setCode =
				options.setExitCode ??
				((code: number) => {
					process.exitCode = code;
				});
			setCode(PARKED_EXIT);
		};
		parked = true;
		(options.restartWith ?? restartWith)(fresh, throughHolder);
		void ctx.shutdown();
		return undefined;
	};
	const unasked = bus.on(RESTART_ASK, (data) => {
		if (!isRestartAsk(data) || data.session !== session) return;
		const why = restartInto(data.sessionFile, data.asked === true);
		if (why === undefined) data.restarting = true;
		else data.why = why;
	});
	// Why it stays awake, kept where Agents and a count can read it, and
	// written only when the reason changes, not every minute.
	let said: string | undefined;
	const note = (why: string | undefined) => {
		if (why === said) return;
		said = why;
		try {
			if (why === undefined || why === "parking already") {
				clearAwake(session, folder);
			} else {
				writeAwake(
					{ session, why, since: new Date(now()).toISOString() },
					folder,
				);
			}
		} catch {
			// A park folder that can't be written costs the note, never the park.
		}
	};
	const look = (): string | undefined => {
		const why = decide();
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
		restartInto,
		stop() {
			unasked();
			clearInterval(clock);
			note(undefined);
		},
	};
}
