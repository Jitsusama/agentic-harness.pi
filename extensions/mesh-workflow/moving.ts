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
 * says where it is moving and what holds it meanwhile. Away mode, whose
 * send-backs would otherwise start a run as each settles for as long as
 * the person is away, holds them in the log while its presence says a
 * move waits (away-workflow held-back.ts), so the move finds a gap.
 *
 * A move never waits forever: one still held {@link MOVE_WAIT_MOST_MS}
 * after it was asked, counted through a reload, calls itself off and
 * stays plain pi, saying so on screen. Its presence says why any move
 * was called off rather than made (`moveOff`), until another is asked.
 *
 * A move back to plain pi waits a run out only {@link RELEASE_WAIT_MS}:
 * past that, it ends the run at its turn's end, its tools done and their
 * results in the log, as a pause does, and leaves the record that tells
 * plain pi the move stopped it and to carry on (job-workflow
 * cut-off.ts), rather than hold the release for the whole
 * {@link MOVE_WAIT_MOST_MS}. A run that starts after, before it lets
 * go, is ended as it starts. Only a run is ended so: what a job, a
 * prompt or typed words hold is waited out as before.
 *
 * The person resuming it or sending it a message from its window calls
 * a move off, as it ends a pause: they are at the desk. A move to `pi` is
 * for a hosted conversation only; asked of a pi, it is said and dropped.
 * It goes through its host as a release rather than a close, so a window
 * viewing it through the join carries on there as plain pi (host-join.ts);
 * only when the host makes no release does it close as before.
 *
 * A pi that can hand its own window to a host (in-place.ts) moves in
 * it rather than closing it, and a message its person sends doesn't
 * call the move off: the run it starts holds the move, which waits for
 * them. Keys pressed without sending anything are seen apart from
 * messages, through the window's own input, and only ever defer it: it
 * goes only after {@link QUIET_MS} with no key pressed in the window,
 * on top of being free, and says nothing
 * on screen as it goes, since its window carries straight on in the
 * host. One that finds no quiet moment within {@link QUIET_BOUND_MS}
 * gives up for now and looks again after {@link QUIET_REST_MS}, rather
 * than moving under someone typing.
 *
 * The person can ask from inside the window too, with /host
 * (host-command.ts): the same move, said as asked there, and saying at
 * once what it waits for first.
 *
 * While a move waits, and until its session ends once it is made, it
 * holds off the reload an install's move would start
 * (lib/internal/session/move-waiting.ts): that reload, going as the same
 * run settles, stops the move unwritten, and the move restarts the
 * session on current code anyway. It renews the hold at every look and
 * lets it go when it is called off or stops.
 */

import type {
	EventBus,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CarriedEnvironment } from "../../lib/internal/session/carried-environment.ts";
import { RUN_UNDER_WAY, whatHolds } from "../../lib/internal/session/free.ts";
import type { MoveNote, MoveTarget } from "../../lib/internal/session/move.ts";
import { findJobHost } from "../../lib/jobs/host.ts";
import type { MoveOff, Moving } from "../../lib/mesh/moving.ts";
import type { HandOver } from "./in-place.ts";

/** How often a waiting move looks again at what holds the session. */
export const MOVE_LOOK_MS = 2_000;

/**
 * How long a move waits for its session to be free before it calls
 * itself off: the cutover's default deadline for giving back what
 * didn't move (scripts/host-cutover.ts), so a move waits no longer
 * than whoever asked it watches.
 */
export const MOVE_WAIT_MOST_MS = 45 * 60_000;

/**
 * How long a move back to plain pi waits on a run before it ends the run
 * at its turn's end: plain pi carries it on, so a busy conversation
 * doesn't keep a release waiting.
 */
export const RELEASE_WAIT_MS = 5 * 60_000;

/** How long a window goes with no key pressed before it moves in place. */
export const QUIET_MS = 5_000;

/** How long a move in place looks for a quiet moment before it rests. */
export const QUIET_BOUND_MS = 60_000;

/** How long a move in place that found no quiet moment rests. */
export const QUIET_REST_MS = 5 * 60_000;

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
	/**
	 * Keep that the move waiting is off rather than made, and why; the
	 * move it waits to make is then none. Without it, only the move is
	 * dropped.
	 */
	readonly calledOff?: (off: MoveOff) => void;
	/** Leave the note the move is taken up by; throws when it can't. */
	readonly note: (to: MoveTarget) => void;
	/**
	 * How it would hand its own window to a host, or nothing when a move
	 * must close the window (in-place.ts).
	 */
	readonly handOver?: () => HandOver | undefined;
	/** When a key was last pressed in its window, in ms since the epoch. */
	readonly keyedAt?: () => number;
	/** Say on screen what the person did. */
	readonly tell: (text: string) => void;
	/** End the session, as /exit does. */
	readonly close: (by: string) => void;
	/**
	 * Have its host let the conversation go back to plain pi, as the
	 * host's release does, so a window viewing it carries on there as
	 * that pi, saying `by` asked: whether the host said it had. A hosted
	 * conversation only.
	 */
	readonly release?: (by: string) => Promise<boolean>;
	/**
	 * End the run under way, leaving the record that `by` ended it for
	 * plain pi to carry on from. A hosted conversation only.
	 */
	readonly cutRun?: (by: string) => void;
	/** Hold an install's reload of the session off for a move to `to`, or renew the hold. */
	readonly holdReloads?: (to: MoveTarget) => void;
	/** Let an install's reload of the session go again. */
	readonly letReloadsGo?: () => void;
	readonly now?: () => Date;
	/** Look again every so often; answers how to stop. */
	readonly every?: (ms: number, look: () => void) => () => void;
}

/** Where the person asked for a move: from outside its window, or in it. */
export type AskedFrom = "outside" | "here";

/** Moving for one session. */
export interface MovingSession {
	/** The person asked it to move to `to`, from outside the window unless said. */
	move(to: MoveTarget, asked?: AskedFrom): void;
	/** The person is at the desk: a move waiting is called off. */
	cancel(): void;
	/**
	 * The person sent a message from its window: a move waiting is called
	 * off, unless it moves in place, which waits for them instead.
	 */
	typed(): void;
	/** Something changed: a move waiting ends the session once it's free. */
	look(): void;
	/** A turn ended, its tools done: a run a move waited on too long ends. */
	turnEnded(): void;
	/** A run started: one starting after the move ended a run ends too. */
	started(): void;
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

/**
 * End a hosted conversation moving to plain pi through its host's
 * release, which tells its viewers it was released rather than closed;
 * a release the host didn't say it made ends it as Close does.
 */
async function letGo(
	host: MovingHost,
	release: (by: string) => Promise<boolean>,
	by: string,
): Promise<void> {
	let released = false;
	try {
		released = await release(by);
	} catch {
		// An unanswered release reads as none made: the session closes as
		// before, and a viewer on it closes with it.
	}
	if (!released) host.close(by);
}

/** What a move says as it is asked, waiting on `holds` when it does. */
function movingSaid(
	to: MoveTarget,
	asked: AskedFrom,
	holds: string | undefined,
): string {
	if (asked === "outside") {
		return `Moving to ${whereTo(to)} from outside this window, once nothing of its own is out.`;
	}
	return holds === undefined
		? `Moving to ${whereTo(to)} in this window, once nothing of its own is out.`
		: `Moving to ${whereTo(to)} in this window; waiting first, as ${holds}.`;
}

/** Moving, as its peer last left it. */
export function createMoving(host: MovingHost): MovingSession {
	const now = host.now ?? (() => new Date());
	const every = host.every ?? everyFew;
	let ended = false;
	let unwatch: (() => void) | undefined;
	// A move in place: when it began looking for a quiet moment, and
	// until when it rests after finding none.
	let seeking: number | undefined;
	let restsUntil = Number.NEGATIVE_INFINITY;
	// Where the move waiting was asked, as its close says.
	let askedFrom: AskedFrom = "outside";
	// Whether a move back to plain pi ends the runs that hold it.
	let cutting = false;
	const cut = () => {
		if (!cutting || ended || host.moving() === undefined) return;
		host.cutRun?.(
			`a move to plain pi that waited ${RELEASE_WAIT_MS / 60_000} minutes on its run`,
		);
	};
	/** Whether a move waiting `waited` ms on `holds` ends the run instead. */
	const cutsRun = (moving: Moving, holds: string, waited: number) =>
		moving.to === "pi" &&
		host.cutRun !== undefined &&
		holds === RUN_UNDER_WAY &&
		waited >= RELEASE_WAIT_MS;
	const unlook = () => {
		unwatch?.();
		unwatch = undefined;
	};
	/** Call the move waiting off, saying `told` on screen and `why` in presence. */
	const callOff = (moving: Moving, why: string, told: string) => {
		unlook();
		host.letReloadsGo?.();
		cutting = false;
		const off = {
			to: moving.to,
			since: moving.since,
			at: now().toISOString(),
			why,
		};
		if (host.calledOff) host.calledOff(off);
		else host.setMoving(undefined);
		host.tell(told);
	};
	const wait = (moving: Moving, holds: string) => {
		const waited = now().getTime() - Date.parse(moving.since);
		if (waited >= MOVE_WAIT_MOST_MS) {
			const why = `it waited ${MOVE_WAIT_MOST_MS / 60_000} minutes and is still held: ${holds}`;
			callOff(moving, why, `The move to ${whereTo(moving.to)} is off: ${why}.`);
			return;
		}
		if (cutsRun(moving, holds, waited)) cutting = true;
		const said =
			cutting && holds === RUN_UNDER_WAY
				? `${holds}, ending at its turn's end after ${RELEASE_WAIT_MS / 60_000} minutes`
				: holds;
		if (said !== moving.holds) host.setMoving({ ...moving, holds: said });
		unwatch ??= every(MOVE_LOOK_MS, look);
	};
	/** What still holds a move in place for want of quiet, or nothing. */
	const unquiet = (at: number): string | undefined => {
		if (at < restsUntil) {
			return `no quiet moment in its window; looking again at ${new Date(restsUntil).toISOString()}`;
		}
		const keyedAt = host.keyedAt?.() ?? Number.NEGATIVE_INFINITY;
		if (at - keyedAt >= QUIET_MS) return undefined;
		seeking ??= at;
		if (at - seeking < QUIET_BOUND_MS) return "its person typing";
		seeking = undefined;
		restsUntil = at + QUIET_REST_MS;
		return unquiet(at);
	};
	const look = () => {
		const moving = host.moving();
		if (moving === undefined || ended) {
			unlook();
			// A move made keeps its hold until its session ends; one dropped
			// elsewhere lets go now.
			if (moving === undefined) host.letReloadsGo?.();
			return;
		}
		host.holdReloads?.(moving.to);
		const holds = host.holds();
		if (holds !== undefined) {
			wait(moving, holds);
			return;
		}
		const over = moving.to === "pi" ? undefined : host.handOver?.();
		const still = over ? unquiet(now().getTime()) : undefined;
		if (still !== undefined) {
			wait(moving, still);
			return;
		}
		unlook();
		// Its holder is told before the move is noted, so one that can't be
		// leaves the session open in its window, which says why.
		const untold = over?.tell();
		if (untold !== undefined) {
			callOff(
				moving,
				untold,
				`This session couldn't move to ${whereTo(moving.to)}, so it stays open: ${untold}`,
			);
			return;
		}
		try {
			host.note(moving.to);
		} catch (error) {
			over?.untell();
			const why = error instanceof Error ? error.message : String(error);
			callOff(
				moving,
				`its note couldn't be written: ${why}`,
				`This session couldn't move to ${whereTo(moving.to)}, so it stays open: ${why}`,
			);
			return;
		}
		ended = true;
		// Handed over, it says nothing, since its window carries straight on
		// in the host.
		if (over) over.quiet();
		else host.tell(`Free now; moving to ${whereTo(moving.to)}.`);
		const by = `a move to ${whereTo(moving.to)}, ${askedFrom === "here" ? "asked in its window" : "asked from outside its window"}`;
		if (moving.to === "pi" && host.release) {
			void letGo(host, host.release, by);
			return;
		}
		host.close(by);
	};
	const cancel = () => {
		const moving = host.moving();
		if (ended || moving === undefined) return;
		callOff(
			moving,
			"the person is at the desk",
			"The move is off: the person is at the desk.",
		);
	};
	return {
		move(to, asked = "outside") {
			if (ended) return;
			if (to === "pi" && !host.hosted()) {
				host.tell(
					"Asked from outside this window to move to plain pi, but it runs in plain pi already.",
				);
				return;
			}
			seeking = undefined;
			restsUntil = Number.NEGATIVE_INFINITY;
			askedFrom = asked;
			cutting = false;
			host.setMoving({ to, since: now().toISOString() });
			host.tell(movingSaid(to, asked, host.holds()));
			look();
		},
		cancel,
		typed() {
			const moving = host.moving();
			if (ended || moving === undefined) return;
			if (moving.to !== "pi" && host.handOver?.()) look();
			else cancel();
		},
		look,
		turnEnded: cut,
		started: cut,
		stop() {
			unlook();
			host.letReloadsGo?.();
		},
	};
}

/**
 * What holds a pi session now, as a move asks: its run, queued messages,
 * the jobs that can't be carried with it, named, the prompts open for
 * its person (`prompts`, counted from pi's prompt events) and its
 * editor's text. A job host from before carrying holds on every job.
 * With `runAside`, a run under way isn't counted, for an ordered carry
 * that ends the run itself once nothing else holds.
 */
export function holdsOf(
	ctx: ExtensionContext | undefined,
	events: EventBus | undefined,
	prompts: number,
	options: { readonly runAside?: boolean } = {},
): string | undefined {
	if (!ctx) return "the session isn't there yet";
	let typed = false;
	try {
		typed = ctx.hasUI && ctx.ui.getEditorText().trim() !== "";
	} catch {
		// A screen with no editor to read holds no typed words.
	}
	const host = events ? findJobHost(events) : undefined;
	const heldBy = host?.holds?.();
	return whatHolds({
		agentIdle: options.runAside === true || ctx.isIdle(),
		pendingMessages: ctx.hasPendingMessages(),
		jobs: heldBy ? heldBy.length : (host?.pending?.() ?? 0),
		...(heldBy ? { heldBy } : {}),
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
	/** How it runs its commands, as its own environment says (move.ts). */
	readonly env?: CarriedEnvironment;
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
		...(mover.env ? { env: mover.env } : {}),
	};
}
