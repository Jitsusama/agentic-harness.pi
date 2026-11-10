// Run in the page, sent by probe.ts's observerBootstrap(), which says what it does.
(() => {
	const named = (node) => {
		if (!node) return null;
		if (node.id) return `#${node.id}`;
		if (!node.tagName) return null;
		const tag = node.tagName.toLowerCase();
		const first = node.classList?.[0];
		return first ? `${tag}.${first}` : tag;
	};

	const vitals = {
		lcp: null,
		shifts: [],
		longTasks: [],
		paints: {},
		// Which observers are actually running, so a measure is only
		// reported when something was watching for it. A zero from an
		// observer that never installed is not a zero.
		installed: [],
		unavailable: [],
	};
	globalThis.__piVitals = vitals;

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
			vitals.unavailable.push(`${type}: ${String(error)}`);
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
})();
