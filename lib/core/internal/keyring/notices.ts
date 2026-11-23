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
 * notice waits until every screen listening has it: each retry, and each
 * listener that comes, offers it again to the screens still without it.
 * A screen that never shows it keeps it waiting, held once however
 * often it is said.
 */

/** One thing to tell the person. */
export interface KeyringNotice {
	readonly level: "info" | "warning";
	readonly message: string;
}

/**
 * Shows a notice, at once rather than in a promise. Answering false
 * declines it, having nowhere to show it; answering nothing or true
 * means it was shown.
 */
type Listener = (notice: KeyringNotice) => boolean | undefined;

/** Each listener, beside the screen it shows notices on. */
const listeners = new Map<Listener, object>();
/** What some screen listening, or the next to listen, hasn't shown yet. */
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

/** Keep `notice` for a later offer, once, however often it is said. */
function wait(notice: KeyringNotice): void {
	if (!waiting.some((each) => each.message === notice.message))
		waiting.push(notice);
}

/**
 * Offer `notice` to each screen that hasn't shown it. Answers whether
 * every screen listening has it now, and false when none listens.
 */
function offer(notice: KeyringNotice): boolean {
	const lacking = new Set<object>();
	const having = new Set<object>();
	for (const [listener, screen] of listeners)
		if (show(listener, screen, notice)) having.add(screen);
		else lacking.add(screen);
	for (const screen of having) lacking.delete(screen);
	return having.size > 0 && lacking.size === 0;
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
 * Hear every notice from now on, and those still waiting, on `screen`,
 * which shows the same words once whichever of its listeners hears
 * them. Answers the function that stops listening.
 */
export function onKeyringNotice(
	listener: Listener,
	screen: object = listener,
): () => void {
	listeners.set(listener, screen);
	retryKeyringNotices();
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
