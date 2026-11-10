/**
 * Move: what the person does from outside the window to hand a session
 * to a host, or back to plain pi from one, through a steer's `act`
 * (lib/internal/session/move.ts says the whole of it).
 *
 * A move waits for the session to be free: no run under way, no message
 * queued, no background job out, no prompt open, nothing typed and
 * unsent (lib/internal/session/free.ts). It doesn't hold runs off, as a
 * pause does, since a run held off would leave a job's result or a
 * peer's message unanswered in the file the host takes up. It only ends
 * the session between them, the first moment nothing is out: it writes
 * the note the move is taken up by and ends as Close does. Its presence
 * says where it is moving and what holds it meanwhile.
 *
 * The person resuming, talking to it or typing in its window calls a
 * move off, as it ends a pause: they are at the desk. A move to `pi` is
 * for a hosted conversation only; asked of a pi, it is said and dropped.
 */

import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { whatHolds } from "../../lib/internal/session/free.ts";
import type { MoveNote, MoveTarget } from "../../lib/internal/session/move.ts";
import { findJobHost } from "../../lib/jobs/host.ts";
import type { Moving } from "../../lib/mesh/presence.ts";

/** How often a waiting move looks again at what holds the session. */
export const MOVE_LOOK_MS = 2_000;

/** What a move needs from its session. */
export interface MovingHost {
	/** What holds the session now, or nothing when it could end. */
	readonly holds: () => string | undefined;
	/** Whether it runs in a host. */
	readonly hosted: () => boolean;
	/** The move it waits to make, as its peer keeps it. */
	readonly moving: () => Moving | undefined;
	/** Keep the move it waits to make, or none, in its peer. */
	readonly setMoving: (moving: Moving | undefined) => void;
	/** Leave the note the move is taken up by; throws when it can't. */
	readonly note: (to: MoveTarget) => void;
	/** Say on screen what the person did. */
	readonly tell: (text: string) => void;
	/** End the session, as /exit does. */
	readonly close: () => void;
	readonly now?: () => Date;
	/** Look again every so often; answers how to stop. */
	readonly every?: (ms: number, look: () => void) => () => void;
}

/** Moving for one session. */
export interface MovingSession {
	/** The person asked it to move to `to` from outside the window. */
	move(to: MoveTarget): void;
	/** The person is at the desk: a move waiting is called off. */
	cancel(): void;
	/** Something changed: a move waiting ends the session once it's free. */
	look(): void;
	/** The session ends: stop looking. */
	stop(): void;
}

function everyFew(ms: number, look: () => void): () => void {
	const clock = setInterval(look, ms);
	clock.unref?.();
	return () => clearInterval(clock);
}

/** Where a move goes, as the person reads it. */
function whereTo(to: MoveTarget): string {
	return to === "pi" ? "plain pi" : `the ${to} host`;
}

/** Moving, as its peer last left it. */
export function createMoving(host: MovingHost): MovingSession {
	const now = host.now ?? (() => new Date());
	const every = host.every ?? everyFew;
	let ended = false;
	let unwatch: (() => void) | undefined;
	const unlook = () => {
		unwatch?.();
		unwatch = undefined;
	};
	const look = () => {
		const moving = host.moving();
		if (moving === undefined || ended) {
			unlook();
			return;
		}
		const holds = host.holds();
		if (holds !== undefined) {
			if (holds !== moving.holds) host.setMoving({ ...moving, holds });
			unwatch ??= every(MOVE_LOOK_MS, look);
			return;
		}
		unlook();
		try {
			host.note(moving.to);
		} catch (error) {
			host.setMoving(undefined);
			host.tell(
				`This session couldn't move to ${whereTo(moving.to)}, so it stays open: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		ended = true;
		host.tell(`Free now; moving to ${whereTo(moving.to)}.`);
		host.close();
	};
	return {
		move(to) {
			if (ended) return;
			if (to === "pi" && !host.hosted()) {
				host.tell(
					"Asked from outside this window to move to plain pi, but it runs in plain pi already.",
				);
				return;
			}
			host.setMoving({ to, since: now().toISOString() });
			host.tell(
				`Moving to ${whereTo(to)} from outside this window, once nothing of its own is out.`,
			);
			look();
		},
		cancel() {
			if (ended || host.moving() === undefined) return;
			unlook();
			host.setMoving(undefined);
			host.tell("The move is off: the person is at the desk.");
		},
		look,
		stop: unlook,
	};
}

/**
 * What holds a pi session now, as a move asks: its run, queued messages,
 * jobs, the prompts open for its person (`prompts`, counted from pi's
 * prompt events) and its editor's text.
 */
export function holdsOf(
	ctx: ExtensionContext | undefined,
	events: EventBus | undefined,
	prompts: number,
): string | undefined {
	if (!ctx) return "the session isn't there yet";
	let typed = false;
	try {
		typed = ctx.hasUI && ctx.ui.getEditorText().trim() !== "";
	} catch {
		// A screen with no editor to read holds no typed words.
	}
	return whatHolds({
		agentIdle: ctx.isIdle(),
		pendingMessages: ctx.hasPendingMessages(),
		jobs: (events ? findJobHost(events)?.pending?.() : undefined) ?? 0,
		prompting: prompts > 0,
		typed,
	});
}

/** Who is moving, as the note names it. */
export interface Mover {
	readonly session: string;
	readonly cwd: string;
	readonly addresses: readonly string[];
	readonly quest?: string;
	readonly title?: string;
	/** The host it runs in, by key, when it runs in one. */
	readonly from?: string;
	/** The process that owns it, as its presence says (core/session owner). */
	readonly pid: number;
}

/** The note a session's move leaves; throws when it has no file to move. */
export function moveNoteOf(
	ctx: ExtensionContext,
	mover: Mover,
	to: MoveTarget,
	at: Date = new Date(),
): MoveNote {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile === undefined) {
		throw new Error("it has no saved file for anything to take up.");
	}
	return {
		session: mover.session,
		sessionFile,
		cwd: mover.cwd,
		to,
		at: at.toISOString(),
		addresses: mover.addresses,
		...(mover.quest ? { quest: mover.quest } : {}),
		...(mover.title ? { title: mover.title } : {}),
		...(mover.from ? { from: mover.from } : {}),
		pid: mover.pid,
	};
}
