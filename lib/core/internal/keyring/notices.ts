/**
 * What the keyring documents have to say to the person: a move done, a
 * keyring that couldn't be reached, a value that wouldn't parse.
 *
 * The documents live in library code with no screen of their own, so
 * they say it here, and the extension that has a screen listens. A
 * notice said before anyone listens waits for the first listener, and
 * reaches that one only, rather than going nowhere, and the same words are said once a process, since
 * a locked keyring would otherwise repeat itself on every read.
 *
 * Each listener names the screen it shows notices on, and a notice
 * reaches each screen once: two extensions keeping credentials in the
 * keyring both listen in a session, and when they share this module
 * rather than each loading its own copy, the person would otherwise
 * read every notice twice.
 */

/** One thing to tell the person. */
export interface KeyringNotice {
	readonly level: "info" | "warning";
	readonly message: string;
}

type Listener = (notice: KeyringNotice) => void;

/** Each listener, beside the screen it shows notices on. */
const listeners = new Map<Listener, object>();
const waiting: KeyringNotice[] = [];
const said = new Set<string>();

/** Tell whoever listens, or the first to listen. */
export function sayKeyringNotice(notice: KeyringNotice): void {
	if (said.has(notice.message)) return;
	said.add(notice.message);
	if (listeners.size === 0) {
		waiting.push(notice);
		return;
	}
	const shown = new Set<object>();
	for (const [listener, screen] of listeners) {
		if (shown.has(screen)) continue;
		shown.add(screen);
		try {
			listener(notice);
		} catch {
			// A notice that failed to show has nowhere to be reported; the
			// screen is left for its next listener, and the rest still hear.
			shown.delete(screen);
		}
	}
}

/**
 * Hear every notice from now on, and those waiting for a listener,
 * on `screen`, which no other listener on it hears again. Answers the
 * function that stops listening.
 */
export function onKeyringNotice(
	listener: Listener,
	screen: object = listener,
): () => void {
	listeners.set(listener, screen);
	for (const notice of waiting.splice(0)) listener(notice);
	return () => {
		listeners.delete(listener);
	};
}

/** Forget what was said and who listens. Tests only. */
export function resetKeyringNotices(): void {
	listeners.clear();
	waiting.length = 0;
	said.clear();
}
