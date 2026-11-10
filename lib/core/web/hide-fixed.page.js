// Run in the page, sent by screenshot.ts's HIDE_FIXED, which says what it does.
(() => {
	for (const el of document.querySelectorAll("body *")) {
		if (getComputedStyle(el).position === "fixed") {
			el.style.setProperty("visibility", "hidden", "important");
		}
	}
})();
