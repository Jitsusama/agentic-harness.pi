/**
 * What the keyring documents have to say to the person: a move done, a
 * keyring that couldn't be reached, a value that wouldn't parse.
 *
 * The documents live in library code with no screen of their own, so
 * they say it here, and the extension that has a screen listens. Each
 * listener names the screen it shows notices on, and the same words
 * reach a screen once: a locked keyring would otherwise repeat itself
 * on every read, and two extensions keeping credentials in the keyring
 * both listen in a session, so sharing this module rather than each
 * loading its own copy would otherwise show every notice twice. A
 * screen that opens later still shows words said before it, when they
 * are said again.
 *
 * A listener that throws leaves the notice to the next listener on its
 * screen. A notice no screen took, said before anyone listens or
 * thrown on by every listener, waits for the next listener to come,
 * and reaches that one only.
 */

/** One thing to tell the person. */
export interface KeyringNotice {
	readonly level: "info" | "warning";
	readonly message: string;
}

type Listener = (notice: KeyringNotice) => void;

/** Each listener, beside the screen it shows notices on. */
const listeners = new Map<Listener, object>();
/** What no screen took yet, for the next listener. */
const waiting: KeyringNotice[] = [];
/** The words each screen has shown. */
let shownOn = new WeakMap<object, Set<string>>();

/** The words `screen` has shown. */
function wordsOn(screen: object): Set<string> {
	const words = shownOn.get(screen) ?? new Set<string>();
	shownOn.set(screen, words);
	return words;
}

/**
 * Show `notice` through `listener`, unless its screen has shown those
 * words. Answers whether the screen has them now.
 */
function show(listener: Listener, screen: object, notice: KeyringNotice) {
	const words = wordsOn(screen);
	if (words.has(notice.message)) return true;
	try {
		listener(notice);
	} catch {
		// A notice that failed to show has nowhere to be reported; it is
		// left for the screen's next listener, or the next to come.
		return false;
	}
	words.add(notice.message);
	return true;
}

/** Keep `notice` for the next listener, once. */
function wait(notice: KeyringNotice): void {
	if (!waiting.some((each) => each.message === notice.message))
		waiting.push(notice);
}

/** Tell each screen that hasn't heard it, or the next listener to come. */
export function sayKeyringNotice(notice: KeyringNotice): void {
	let taken = false;
	for (const [listener, screen] of listeners)
		if (show(listener, screen, notice)) taken = true;
	if (!taken) wait(notice);
}

/**
 * Hear every notice from now on, and those waiting for a listener, on
 * `screen`, which shows the same words once whichever of its listeners
 * hears them. Answers the function that stops listening.
 */
export function onKeyringNotice(
	listener: Listener,
	screen: object = listener,
): () => void {
	listeners.set(listener, screen);
	for (const notice of waiting.splice(0))
		if (!show(listener, screen, notice)) wait(notice);
	return () => {
		listeners.delete(listener);
	};
}

/** Forget what was said and who listens. Tests only. */
export function resetKeyringNotices(): void {
	listeners.clear();
	waiting.length = 0;
	shownOn = new WeakMap();
}
