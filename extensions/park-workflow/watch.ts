/**
 * Watching a session for the still moment it may park, and parking it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AGAIN_ENV,
	clearParked,
	flagsLost,
	opensOnlyItself,
	PARK_ASK,
	PARKED_EXIT,
	PARKING,
	type ParkAsk,
	type Parking,
	parkAfterMs,
	readParked,
	restartCommand,
	SESSION_WOKEN,
	WAKE_ENV,
	whyNotPark,
	writeParked,
} from "../../lib/internal/session/park.ts";
import { findJobHost } from "../../lib/jobs/host.ts";

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
 */
export function mayPark(
	ctx: Pick<ExtensionContext, "hasUI">,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!ctx.hasUI) return false;
	if (env.SUBAGENT_SUPERVISOR === "1" || env.SUBAGENT_RUN_ID) return false;
	return Boolean(env[WAKE_ENV]);
}

/** A session watched for parking. */
export interface Watch {
	/** Something happened in the session: count idle from now. */
	stirred(): void;
	/** A prompt for its person opened or closed. */
	prompting(open: boolean): void;
	/** Look now whether it may park, and park it if so; answers why not. */
	look(): string | undefined;
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
	/** Set the code pi exits with, once it exits. */
	readonly exitWith?: (code: number) => void;
	/** Look on a clock; false for tests that look by hand. */
	readonly clock?: boolean;
	/** This process, which its holder's record must name to park. */
	readonly pid?: number;
}

/** What a window shows once its session has parked. */
export const PARKED_LINE =
	"Parked while idle, holding no memory. A key or a message wakes it.";

/** Say to the process that, whatever pi exits with, it exits with this. */
function exitWith(code: number): void {
	// pi ends a quit with process.exit(0); an exit listener's code wins.
	process.once("exit", () => {
		process.exitCode = code;
		// The window stays with its holder, so it says why it is quiet.
		process.stdout.write(`\r\n${PARKED_LINE}\r\n`);
	});
}

/**
 * Whether the holder runs this very process, as its record beside the
 * wake file says. A pi started through a shell is the shell's child, so
 * its exit would reach the shell and leave a bare prompt, not a park.
 */
function heldDirectly(wake: string, pid: number): boolean {
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(wake.replace(/\.wake$/, ".json"), "utf8"));
	} catch {
		// A record missing or caught half written can't say this process is
		// the one held, and staying up costs only memory.
		return false;
	}
	return namesPid(record, pid);
}

/** Whether a holder's record says it runs `pid`. */
function namesPid(record: unknown, pid: number): boolean {
	return (
		typeof record === "object" &&
		record !== null &&
		"pid" in record &&
		record.pid === pid
	);
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
): string | undefined {
	if (sessionFile === "") return "it has no log to start again from";
	// pi writes a log at its first answer, so one never asked anything
	// would wake as a new session, under another address.
	if (!existsSync(sessionFile)) return "its log isn't written yet";
	if (again === "") {
		return opensOnlyItself(args, session, sessionFile)
			? undefined
			: "its holder would start it as a new session";
	}
	const lost = flagsLost(args);
	if (lost.length > 0) return `starting again would drop ${lost.join(", ")}`;
	try {
		writeFileSync(again, JSON.stringify(restartCommand(sessionFile)));
		return undefined;
	} catch {
		return "its holder couldn't be told how to start it again";
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

/** Watch this session, clearing any marker an earlier park left. */
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
	if (woke) bus.emit(SESSION_WOKEN, { session });
	// Idle counts from its log, not from this start: every install that
	// moves reloads every session, and on 6 November installs moved about
	// every half hour, so a clock started here never reached its hour. A
	// session just woken counts from now, or a key that woke it, with
	// nothing sent yet, would see it park again within a minute.
	let last = woke ? now() : Math.min(now(), lastMessageAt(ctx) ?? now());
	let prompts = 0;
	let parked = false;
	const look = (): string | undefined => {
		if (parked) return "parking already";
		const ask: ParkAsk = { session, refusals: [] };
		const afterMs = parkAfterMs(session, options.env, options.switchPath);
		// Others are asked only once it is due, since asking reads the board.
		if (afterMs !== undefined && now() - last >= afterMs) {
			bus.emit(PARK_ASK, ask);
		}
		const why = whyNotPark({
			idleMs: now() - last,
			afterMs,
			agentIdle: ctx.isIdle(),
			pendingMessages: ctx.hasPendingMessages(),
			jobs: findJobHost(bus)?.pending?.() ?? 0,
			prompting: prompts > 0,
			typed: ctx.ui.getEditorText().trim() !== "",
			refusals: ask.refusals,
		});
		if (why !== undefined) return why;
		if (wake === "") return "no holder would wake it";
		if (!heldDirectly(wake, options.pid ?? process.pid)) {
			return "its holder runs it through another program";
		}
		const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
		const unnamed = restartNamed(again, args, session, sessionFile);
		if (unnamed !== undefined) return unnamed;
		parked = true;
		const parking: Parking = { session, addresses: [] };
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
		(options.exitWith ?? exitWith)(PARKED_EXIT);
		void ctx.shutdown();
		return undefined;
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
		look,
		stop() {
			clearInterval(clock);
		},
	};
}
