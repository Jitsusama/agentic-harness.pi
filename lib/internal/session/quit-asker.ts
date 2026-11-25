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
 */

import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

const ASKER_KEY = Symbol.for("agentic-harness.session.quit-asker");

/** How long a caller's ask stays the answer, so a stale one never names a later quit. */
export const ASK_LASTS_MS = 30_000;

/**
 * How long a key's ask lasts: past pi's 500 ms between two ctrl+c and
 * a slow shutdown's start, short of a quit seconds after typing.
 */
export const KEY_LASTS_MS = 2_000;

/**
 * What a held pi exits with when it quits at nobody's ask, so its holder
 * starts it again: just past sysexits' range, clear of `PARKED_EXIT`.
 */
export const UNASKED_EXIT = 79;

/** A quit's asker: who, when in ms since the process started, and for how long. */
export interface QuitAsk {
	readonly by: string;
	readonly atMs: number;
	readonly lastsMs: number;
}

type AskerGlobal = { [ASKER_KEY]?: QuitAsk };

/** Say that `by` asks this process to quit, just before it asks. */
export function askQuit(
	by: string,
	lastsMs = ASK_LASTS_MS,
	atMs = performance.now(),
): void {
	(globalThis as AskerGlobal)[ASKER_KEY] = { by, atMs, lastsMs };
}

/**
 * Who asked this process to quit, when someone named themselves within
 * their ask's span, or undefined.
 */
export function quitAsker(nowMs = performance.now()): string | undefined {
	const ask = (globalThis as AskerGlobal)[ASKER_KEY];
	if (!ask) return undefined;
	if (nowMs - ask.atMs > ask.lastsMs) return undefined;
	return ask.by;
}

/**
 * The person's quit a key in the window may be, given the editor's text
 * as the key arrives: ctrl+d on an empty editor, ctrl+c (pi quits on a
 * second within 500 ms), or enter on `/quit`; otherwise undefined.
 */
export function keyQuit(data: string, editorText: string): string | undefined {
	if (isKeyRelease(data)) return undefined;
	if (matchesKey(data, Key.ctrl("d")) && editorText === "") {
		return "the person's ctrl+d";
	}
	if (matchesKey(data, Key.ctrl("c"))) return "the person's ctrl+c";
	if (matchesKey(data, Key.enter) && editorText.trim() === "/quit") {
		return "the person's /quit";
	}
	return undefined;
}

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
	return `pi: quitting session ${session}, asked by ${asker ?? UNNAMED_QUIT}${then}`;
}
