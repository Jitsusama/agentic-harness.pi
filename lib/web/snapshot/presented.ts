/**
 * Page-side answers to "is this actually being offered to
 * anybody", shared by every probe that has to decide.
 *
 * This ships as a source string, like the deep traversal it sits
 * beside, because it declares helpers of its own and the bundler
 * renames named inner bindings through a wrapper the page has
 * never heard of.
 *
 * It exists because four probes asked this question three
 * different ways. Two settled for a bare checkVisibility(), which
 * answers about display and nothing else, and the disagreement
 * showed up as false findings rather than as a disagreement: a
 * real app's closed dialogs were reported as 48 critical
 * accessibility failures and its screen-reader-only inputs as ten
 * pointer targets one pixel across.
 *
 * The recognition of a visually-hidden idiom is presentational
 * judgment rather than measurement, and is one of this library's
 * declared exceptions to reporting only what the browser said.
 * The browser has no notion of the idiom; without it, every
 * correctly built skip link on every page is a finding.
 */

/** A box no larger than this is a hiding technique, not content. */
export const HIDDEN_BOX_PX = 4;

/**
 * Declares `presented`, `visible`, `inertHere` and
 * `visuallyHidden` for a page-side probe.
 *
 * Prepend it inside the probe's IIFE, as with DEEP_DOM.
 */
export const PRESENTED = `
	// The browser's own answer, but only when asked the whole
	// question. Bare checkVisibility() reports on display alone,
	// so it calls a visibility:hidden control visible, and real
	// apps hide closed menus and dialogs exactly that way.
	//
	// opacity is deliberately not asked about. An opacity:0
	// control is still in the focus order and still clickable, so
	// treating it as absent buries real defects rather than
	// avoiding false ones.
	const visible = (el) =>
		typeof el.checkVisibility === "function"
			? el.checkVisibility({
					visibilityProperty: true,
					contentVisibilityAuto: true,
				})
			: el.getClientRects().length > 0;

	// inert takes a subtree out of interaction without changing
	// anything about how it looks, so no style question finds it.
	// A closed dialog is the ordinary case.
	const inertHere = (el) =>
		typeof el.closest === "function" && el.closest("[inert]") !== null;

	// The screen-reader-only family: clipped to nothing, or parked
	// off the left edge where no scrollable area is created. Such
	// an element is deliberately not shown to sighted users, so it
	// is not something they can look at or aim a pointer at.
	const visuallyHidden = (el) => {
		const rect = el.getBoundingClientRect();
		const tiny =
			rect.width <= ${HIDDEN_BOX_PX} && rect.height <= ${HIDDEN_BOX_PX};
		const style = getComputedStyle(el);
		if (tiny && style.clipPath !== "none") return true;
		if (tiny && style.overflowX === "hidden") return true;
		return rect.x + rect.width < 0;
	};

	// Offered to somebody: painted, not inert, and not hidden by
	// one of the idioms above.
	const presented = (el) =>
		visible(el) && !inertHere(el) && !visuallyHidden(el);
`;
