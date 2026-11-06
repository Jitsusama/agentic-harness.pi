/**
 * Watching a session for the still moment it may park, and parking it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clearParked,
	PARK_ASK,
	PARKED_EXIT,
	PARKING,
	type ParkAsk,
	type Parking,
	parkAfterMs,
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
	/** Set the code pi exits with, once it exits. */
	readonly exitWith?: (code: number) => void;
	/** Look on a clock; false for tests that look by hand. */
	readonly clock?: boolean;
}

/** Say to the process that, whatever pi exits with, it exits with this. */
function exitWith(code: number): void {
	// pi ends a quit with process.exit(0); an exit listener's code wins.
	process.once("exit", () => {
		process.exitCode = code;
	});
}

/** Watch this session, clearing any marker an earlier park left. */
export function watch(
	ctx: Parkable,
	bus: Bus,
	options: WatchOptions = {},
): Watch {
	const now = options.now ?? Date.now;
	const wake = (options.env ?? process.env)[WAKE_ENV] ?? "";
	const session = ctx.sessionManager.getSessionId();
	const folder = options.folder;
	// Started again, it is parked no more; its holder clears the wake.
	clearParked(session, folder);
	let last = now();
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
		parked = true;
		const parking: Parking = { session, addresses: [] };
		bus.emit(PARKING, parking);
		writeParked(
			{
				session,
				sessionFile: ctx.sessionManager.getSessionFile() ?? "",
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
