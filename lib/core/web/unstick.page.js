// Run in the page, sent by screenshot.ts's UNSTICK, which says what it does.
(() => {
	for (const el of document.querySelectorAll("body *")) {
		if (getComputedStyle(el).position === "sticky") {
			el.style.setProperty("position", "relative", "important");
			el.style.setProperty("inset", "auto", "important");
		}
	}
})();
