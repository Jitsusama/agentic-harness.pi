/**
 * Installing the performance observers, and reading them back.
 *
 * The bootstrap has to run before anything on the page does.
 * Largest contentful paint and layout shift are events, not
 * state, and an observer registered after the fact sees only
 * what happens next. Chrome's buffered flag recovers some of it,
 * but not the element that painted or the nodes that moved,
 * which is the part worth having.
 *
 * So it goes in through addScriptToEvaluateOnNewDocument, which
 * fires ahead of every navigation, and the whole thing is
 * wrapped in a try: an observer type the browser does not
 * support must cost the other observers nothing.
 */

/**
 * The script installed before every navigation.
 *
 * Nodes are named the way a person would look for them rather
 * than held as references. A retained node keeps a detached
 * subtree alive, and measuring a page should not change what it
 * costs.
 */
export function observerBootstrap(): string {
	return `(() => {
	const named = (node) => {
		if (!node) return null;
		if (node.id) return "#" + node.id;
		if (!node.tagName) return null;
		const tag = node.tagName.toLowerCase();
		const first = node.classList && node.classList[0];
		return first ? tag + "." + first : tag;
	};

	const vitals = {
		lcp: null, shifts: [], longTasks: [], paints: {},
		// Which observers are actually running, so a measure is only
		// reported when something was watching for it. A zero from an
		// observer that never installed is not a zero.
		installed: [], unavailable: [],
	};
	window.__piVitals = vitals;

	const watch = (type, handle) => {
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) handle(entry);
			}).observe({ type, buffered: true });
			vitals.installed.push(type);
		} catch (error) {
			// One unsupported entry type must not cost the others. It
			// used to write a single shared error field that the
			// renderer treated as fatal, so losing longtask on a browser
			// that does not support it threw away the paints and the
			// layout shifts that had been collected perfectly well.
			vitals.unavailable.push(type + ": " + String(error));
		}
	};

	watch("largest-contentful-paint", (entry) => {
		vitals.lcp = {
			time: entry.startTime,
			size: entry.size,
			element: named(entry.element),
			url: entry.url || null,
		};
	});

	watch("layout-shift", (entry) => {
		// A shift the person caused by interacting is not a fault.
		if (entry.hadRecentInput) return;
		vitals.shifts.push({
			value: entry.value,
			time: entry.startTime,
			sources: (entry.sources || []).map((source) => ({
				node: named(source.node),
				from: source.previousRect
					? [source.previousRect.x, source.previousRect.y]
					: null,
				to: source.currentRect
					? [source.currentRect.x, source.currentRect.y]
					: null,
			})),
		});
	});

	watch("longtask", (entry) => {
		vitals.longTasks.push({ time: entry.startTime, duration: entry.duration });
	});

	watch("paint", (entry) => {
		vitals.paints[entry.name] = entry.startTime;
	});
})()`;
}

/** The expression that reads the observers back. */
export function readVitalsSource(): string {
	return `(() => {
	const vitals = window.__piVitals;
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
})()`;
}
