/**
 * Waiting for a page to stop changing before reading it.
 *
 * Every tool that acts on the page answers with a fresh outline,
 * and that promise was quietly broken for any app that renders on
 * the client. Navigating to a real application returned an outline
 * whose only content was a live region saying "Loading page", and
 * pressing Enter on a search box returned the page as it was
 * before the result arrived. Both looked like the tool reporting a
 * page with nothing on it, rather than a tool that read too early,
 * which is the worse of the two failures: the caller reasons
 * confidently about a page that no longer exists.
 *
 * Waiting on the network is not enough on its own. Chrome's own
 * idle heuristics were already in use and had already declared
 * this page idle, because the app fetches its content after the
 * document settles. What actually indicates a rendered page is the
 * DOM going quiet, so that is what this watches, with the network
 * as a second signal rather than the only one.
 *
 * This ships as a page-side source string, like the other probes
 * that declare helpers of their own.
 */

/** How long the DOM must be still before the page counts as settled. */
export const SETTLE_QUIET_MS = 150;

/**
 * The longest we wait for stillness.
 *
 * A page that animates for ever, polls on a timer, or streams
 * updates never goes quiet, and waiting on it would hang the one
 * call a caller makes most. When the budget runs out the page is
 * read anyway and the answer says it was still changing, because a
 * reading of a moving page is worth having as long as nobody is
 * told it was final.
 */
export const SETTLE_BUDGET_MS = 2000;

/** What a settle attempt found. */
export interface Settled {
	/** Whether the page went quiet within its budget. */
	readonly quiet: boolean;
	/** How long it took, or the budget when it never settled. */
	readonly waitedMs: number;
	/** DOM mutations seen while waiting, for a page that never stopped. */
	readonly mutations: number;
}

/**
 * Page-side source: resolve once the DOM has been still for
 * `quietMs`, or when `budgetMs` runs out.
 *
 * Counting mutations rather than merely noticing them lets the
 * answer distinguish a page that is busy from one that never
 * started, which are told apart nowhere else.
 */
export function settleSource(
	quietMs: number = SETTLE_QUIET_MS,
	budgetMs: number = SETTLE_BUDGET_MS,
): string {
	return `(() => new Promise((resolve) => {
	const started = Date.now();
	let mutations = 0;
	let quietTimer;
	let observer;

	const finish = (quiet) => {
		clearTimeout(quietTimer);
		clearTimeout(deadline);
		if (observer) observer.disconnect();
		resolve({ quiet, waitedMs: Date.now() - started, mutations });
	};

	const deadline = setTimeout(() => finish(false), ${budgetMs});

	const armQuiet = () => {
		clearTimeout(quietTimer);
		quietTimer = setTimeout(() => finish(true), ${quietMs});
	};

	try {
		observer = new MutationObserver((records) => {
			mutations += records.length;
			armQuiet();
		});
		observer.observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
	} catch (error) {
		// No observer available: fall back to the quiet timer alone,
		// which still gives the page a moment to paint.
	}

	armQuiet();
}))()`;
}
