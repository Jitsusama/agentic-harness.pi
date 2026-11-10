// Run in the page, sent by walkprobe.ts's WALK_REMEMBER, which says what it does.
(() => {
	globalThis.__walkOrigin = {
		el: document.activeElement,
		x: globalThis.scrollX,
		y: globalThis.scrollY,
	};
	return true;
})();
