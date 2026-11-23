/**
 * What the keyring documents have to say to the person: a move done, a
 * keyring that couldn't be reached, a value that wouldn't parse.
 *
 * The documents live in library code with no screen of their own, so
 * they say it here, and the extension that has a screen listens. Each
 * listener names what it shows notices on, a session, and the same
 * words reach a session once, whichever screen it has: a locked keyring
 * would otherwise repeat itself on every read, and two extensions
 * keeping credentials in the keyring both listen in a session, so
 * sharing this module rather than each loading its own copy would
 * otherwise show every notice twice. A session that starts later still
 * shows words said before it, when they are said again.
 *
 * A listener with nowhere to show a notice declines it, and one that
 * throws leaves it to the next listener on its screen; either way the
 * words aren't marked shown there, so they show when said again. A
 * notice no screen took waits: the next listener to come takes it, and
 * each retry offers it to every screen.
 */

/** One thing to tell the person. */
export interface KeyringNotice {
	readonly level: "info" | "warning";
	readonly message: string;
}

/**
 * Shows a notice. Answering false declines it, having nowhere to show
 * it; any other answer means it was shown.
 */
type Listener = (notice: KeyringNotice) => unknown;

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
		if (listener(notice) === false) return false;
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

/** Offer `notice` to each screen that hasn't shown it; answers whether one took it. */
function offer(notice: KeyringNotice): boolean {
	let taken = false;
	for (const [listener, screen] of listeners)
		if (show(listener, screen, notice)) taken = true;
	return taken;
}

/** Tell each screen that hasn't heard it, or the next listener to come. */
export function sayKeyringNotice(notice: KeyringNotice): void {
	if (!offer(notice)) wait(notice);
}

/** Offer each waiting notice to every screen again, as one may have come since. */
export function retryKeyringNotices(): void {
	for (const notice of waiting.splice(0)) if (!offer(notice)) wait(notice);
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
