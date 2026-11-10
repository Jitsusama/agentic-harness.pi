// Run in the page, sent by walkprobe.ts's WALK_RESTORE, which says what it does.
(() => {
	const origin = globalThis.__walkOrigin;
	if (document.activeElement?.blur) {
		document.activeElement.blur();
	}
	if (origin) {
		const el = origin.el;
		// Refocusing only makes sense if it is still in the document
		// and could hold focus in the first place; body cannot.
		if (
			el?.isConnected &&
			typeof el.focus === "function" &&
			el !== document.body &&
			el !== document.documentElement
		) {
			try {
				el.focus({ preventScroll: true });
			} catch {
				/* gone */
			}
		}
		globalThis.scrollTo(origin.x, origin.y);
	}
	globalThis.__walkOrigin = undefined;
	globalThis.__walkCandidates = undefined;
	return true;
})();
