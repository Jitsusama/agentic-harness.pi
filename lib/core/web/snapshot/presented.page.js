// Run in the page, sent by presented.ts's PRESENTED, which says what it does.
({ HIDDEN_BOX_PX }) => {
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
		const tiny = rect.width <= HIDDEN_BOX_PX && rect.height <= HIDDEN_BOX_PX;
		const style = getComputedStyle(el);
		if (tiny && style.clipPath !== "none") return true;
		if (tiny && style.overflowX === "hidden") return true;
		return rect.x + rect.width < 0;
	};

	// Offered to somebody: painted, not inert, and not hidden by
	// one of the idioms above.
	const presented = (el) =>
		visible(el) && !inertHere(el) && !visuallyHidden(el);
	return { visible, inertHere, visuallyHidden, presented };
};
