/**
 * Who asked a plain pi to quit.
 *
 * pi's shutdown carries no reason: a key in the window, a mesh Close,
 * the quest ending and pi's own TERM handler all end in the same
 * `session_shutdown` of reason "quit" and the same exit 0. On 25
 * November a held pi quit 52 seconds after the node restarted, and its
 * holder, seeing 0, restarted nothing; nothing on disk said who had
 * asked. So whatever asks a plain pi to quit names itself here first,
 * and the crash record reads the name back as the session ends. A quit
 * nobody named is one nobody meant, so a held pi ends it with
 * `UNASKED_EXIT`, which its holder answers by starting it again.
 *
 * Held on the process rather than a module, since a reload loads every
 * module afresh and an ask made by the old load must still be read.
 *
 * It imports nothing of pi's, since a plain node child, as a council's
 * supervisor, reaches it through the session's owner; reading the
 * person's keys, which needs pi-tui, is `quit-keys.ts`.
 */

import { processGlobal } from "../process/process-global.ts";

/**
 * How long an ask stays the answer, so a stale one never names a later
 * quit: past the slowest shutdown handlers seen, short of a quit much
 * later. A key's ask is taken back sooner, by the next key that isn't
 * a quit.
 */
export const ASK_LASTS_MS = 30_000;

/**
 * What a held pi exits with when it quits at nobody's ask, so its holder
 * starts it again: just past sysexits' range, clear of `PARKED_EXIT`.
 */
export const UNASKED_EXIT = 79;

/**
 * The signal an unasked quit ends by when its exit would wait on a name
 * lookup, which only a signal's default action ends: its holder starts
 * it again on this as on `UNASKED_EXIT`, where a TERM's 143 is a quit
 * someone meant.
 */
export const UNASKED_SIGNAL = "SIGUSR2";

/** A quit's asker: who, when in ms since the process started, and for how long. */
export interface QuitAsk {
	readonly by: string;
	readonly atMs: number;
	readonly lastsMs: number;
}

const asking = processGlobal<{ ask: QuitAsk | undefined }>(
	"agentic-harness.session.quit-asker",
	() => ({ ask: undefined }),
);

/** Say that `by` asks this process to quit, just before it asks. */
export function askQuit(
	by: string,
	lastsMs = ASK_LASTS_MS,
	atMs = performance.now(),
): void {
	asking.ask = { by, atMs, lastsMs };
}

/**
 * Take back `by`'s ask, when the quit it announced didn't come: its
 * shutdown threw, or the key wasn't a quit after all. Another's later
 * ask stands.
 */
export function takeBackQuit(by: string): void {
	if (asking.ask?.by === by) asking.ask = undefined;
}

/**
 * Who asked this process to quit, when someone named themselves within
 * their ask's span, or undefined.
 */
export function quitAsker(nowMs = performance.now()): string | undefined {
	const ask = asking.ask;
	if (!ask) return undefined;
	if (nowMs - ask.atMs > ask.lastsMs) return undefined;
	return ask.by;
}

/**
 * The code a quitting pi ends with: `UNASKED_EXIT` for a held pi nobody
 * asked, where nothing else set a code of its own; otherwise the code
 * it already has, as a park's 75 or one-writer's 78.
 */
export function quitExit(
	asker: string | undefined,
	held: boolean,
	code: number | undefined,
): number | undefined {
	if (asker !== undefined || !held) return code;
	return code === undefined || code === 0 ? UNASKED_EXIT : code;
}

/** What the person's keys quit by, and the keys that quit. */
export const KEY_QUITS = {
	exit: "the person's exit key on an empty editor",
	clear: "the person's second clear key",
	command: "the person's /quit",
} as const;

/** What a quit nobody named is put down to. */
export const UNNAMED_QUIT =
	"nobody that named itself: no key in its window, harness caller or signal";

/** The system log's line for a quit, naming who asked and what follows. */
export function quitLine(
	session: string,
	asker: string | undefined,
	restarts: boolean,
): string {
	const then = restarts
		? `; it exits ${UNASKED_EXIT} so its holder starts it again`
		: "";
	// An asker's name is one line, so none can write a line of its own.
	const by = (asker ?? UNNAMED_QUIT).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");
	return `pi: quitting session ${session}, asked by ${by}${then}`;
}
