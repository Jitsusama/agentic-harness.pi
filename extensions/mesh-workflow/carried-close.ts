/**
 * Closing a session whose work was carried elsewhere, as the person's
 * Carry (pausing.ts) and an ordered one (ordered-carry.ts) both close
 * it, and saying where that close failed.
 *
 * A host's close lands, or fails, after it is asked; one that does
 * neither would leave the session closing for good, every run it then
 * stops ended without a word. So a close that hasn't landed within its
 * deadline counts as failed. A failure is said once, whichever comes
 * first, a failure told, a throw or the deadline, and from then each
 * run the session stops says why: its work runs elsewhere. A close that
 * lands past its deadline says so, so what was said of it isn't left
 * standing.
 *
 * Nothing here asks a person to end the session: a host's later close
 * joins the one that hangs (SessionHost.finish), so it couldn't.
 */

/** How long a carried session's close may take before it counts as failed. */
export const CLOSE_WAIT_MS = 2 * 60_000;

/** A carried session's close, asked. */
export interface CarriedClose {
	/** The machine its work went to, once its close failed; else nothing. */
	readonly goneTo: () => string | undefined;
}

/** What closing a carried session needs. */
export interface ClosingCarried {
	/** The machine its work was carried to. */
	readonly to: string;
	/**
	 * Ask the close, telling `failed` where it fails after this returns
	 * and `closed` where it lands; one that fails at once may throw.
	 */
	readonly close: (
		failed: (error: unknown) => void,
		closed: () => void,
	) => void;
	/** Say that it couldn't close, with `why`; never throws. */
	readonly unclosed: (why: string) => void;
	/** Say that it closed after all, once `unclosed` was said; never throws. */
	readonly closedLate: () => void;
	/** How long the close may take; {@link CLOSE_WAIT_MS} unless a test names less. */
	readonly closeMs?: number;
}

/** Closes a carried session as `closing` says, failing it past its deadline. */
export function closeCarried(closing: ClosingCarried): CarriedClose {
	const closeMs = closing.closeMs ?? CLOSE_WAIT_MS;
	let settled = false;
	let goneTo: string | undefined;
	const settle = (): boolean => {
		if (settled) return false;
		settled = true;
		clearTimeout(deadline);
		return true;
	};
	const failed = (error: unknown): void => {
		if (!settle()) return;
		goneTo = closing.to;
		closing.unclosed(messageOf(error));
	};
	const deadline = setTimeout(
		() => failed(new Error(`it hadn't closed after ${closeMs / 1000} s`)),
		closeMs,
	);
	// A close that lands ends the process; the deadline mustn't hold it.
	deadline.unref?.();
	try {
		closing.close(failed, () => {
			if (!settle() && goneTo !== undefined) closing.closedLate();
		});
	} catch (error) {
		failed(error);
	}
	return { goneTo: () => goneTo };
}

/** What a run stopped once its session's close failed says. */
export function stoppedRun(goneTo: string): string {
	return `This run is stopped: the session was carried to ${goneTo} and runs there.`;
}

/** What was thrown, in words; never throws, as it is said from a catch. */
function messageOf(error: unknown): string {
	try {
		const said = error instanceof Error ? String(error.message) : String(error);
		return said === "" ? "something was thrown that said nothing of why" : said;
	} catch {
		// What was thrown can't say itself; that the close failed still is.
		return "something was thrown that can't be put in words";
	}
}
