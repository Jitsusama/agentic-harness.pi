// Run in the page, sent by probe.ts's readVitalsSource(), which says what it does.
(() => {
	const vitals = globalThis.__piVitals;
	if (!vitals) {
		return {
			shifts: [],
			longTasks: [],
			paints: {},
			error:
				"No observers are installed on this document. They are added " +
				"before a navigation, so a page opened another way has none.",
		};
	}
	const nav = performance.getEntriesByType("navigation")[0];
	return {
		...vitals,
		nav: nav
			? {
					domContentLoaded: nav.domContentLoadedEventEnd,
					load: nav.loadEventEnd,
					responseStart: nav.responseStart,
					transferSize: nav.transferSize,
				}
			: undefined,
	};
})();
