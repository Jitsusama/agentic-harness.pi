/**
 * What the keyring documents have to say to the person: a move done, a
 * keyring that couldn't be reached, a value that wouldn't parse.
 *
 * The documents live in library code with no screen of their own, so
 * they say it here, and the extension that has a screen listens. A
 * notice said before anyone listens waits for the first listener rather
 * than going nowhere, and the same words are said once a process, since
 * a locked keyring would otherwise repeat itself on every read.
 */

/** One thing to tell the person. */
export interface KeyringNotice {
	readonly level: "info" | "warning";
	readonly message: string;
}

type Listener = (notice: KeyringNotice) => void;

const listeners = new Set<Listener>();
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
	for (const listener of listeners) listener(notice);
}

/**
 * Hear every notice from now on, and those waiting for a listener.
 * Answers the function that stops listening.
 */
export function onKeyringNotice(listener: Listener): () => void {
	listeners.add(listener);
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
