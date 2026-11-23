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
 * notice waits for the screens that lacked it when it was said, and each
 * retry offers it to those still listening until they show it; one no
 * screen took waits for whoever listens next. So a session that starts
 * later never replays old words another screen took, though one screen
 * keeps declining them. A notice waits once however often it is said.
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
/** Who a waiting notice is still owed to: these screens, or anyone, as no screen took it. */
type Owed = ReadonlySet<object> | "anyone";

/** Each notice still owed, by its words. */
const waiting = new Map<string, { notice: KeyringNotice; to: Owed }>();
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

/**
 * Offer `notice` to each listening screen it is owed to that hasn't
 * shown it. Answers who it is owed to after: the screens offered it
 * that still lack it, or anyone when none of them took it.
 */
function offer(notice: KeyringNotice, to: Owed): Owed {
	const lacking = new Set<object>();
	const having = new Set<object>();
	for (const [listener, screen] of listeners) {
		if (to !== "anyone" && !to.has(screen)) continue;
		if (show(listener, screen, notice)) having.add(screen);
		else lacking.add(screen);
	}
	if (to === "anyone" && having.size === 0) return "anyone";
	for (const screen of having) lacking.delete(screen);
	return lacking;
}

/**
 * Keep `notice` owed `to` whom, beside what its words were owed before:
 * anyone outranks screens, as it reaches them too.
 */
function keep(notice: KeyringNotice, to: Owed): void {
	const before = waiting.get(notice.message)?.to;
	const owed =
		to === "anyone" || before === undefined || before === "anyone"
			? to
			: new Set([...before, ...to]);
	if (owed !== "anyone" && owed.size === 0) waiting.delete(notice.message);
	else waiting.set(notice.message, { notice, to: owed });
}

/** Tell each screen that hasn't heard it, or the next listener to come. */
export function sayKeyringNotice(notice: KeyringNotice): void {
	keep(notice, offer(notice, "anyone"));
}

/** Offer each waiting notice again to whom it is owed, as a screen may have come since. */
export function retryKeyringNotices(): void {
	const owed = [...waiting.values()];
	waiting.clear();
	for (const { notice, to } of owed) keep(notice, offer(notice, to));
}

/**
 * Hear every notice from now on on `screen`, and those still owed to
 * it or to anyone; the screen shows the same words once whichever of
 * its listeners hears them. Answers the function that stops listening.
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
	waiting.clear();
	shownOn = new WeakMap();
}
