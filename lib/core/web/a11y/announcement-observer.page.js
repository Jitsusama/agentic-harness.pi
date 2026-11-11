// Run in the page, sent by announcements.ts's ANNOUNCEMENT_OBSERVER, which says what it does.
({ BINDING, REGISTRY }) => {
	const CANDIDATE_SELECTOR = "[aria-live], [role], output";
	const epoch = `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;

	globalThis[REGISTRY] = [];
	const indexByElement = new WeakMap();

	function indexOf(element) {
		const known = indexByElement.get(element);
		if (known !== undefined) return known;
		const index = globalThis[REGISTRY].length;
		globalThis[REGISTRY].push(element);
		indexByElement.set(element, index);
		return index;
	}

	function nominate(index, text) {
		const sink = globalThis[BINDING];
		if (sink) {
			sink({ epoch, index, text, at: Date.now() });
		}
	}

	function watch() {
		const observer = new MutationObserver((records) => {
			const seen = {};
			for (let i = 0; i < records.length; i++) {
				const node = records[i].target;
				const element = node.nodeType === 1 ? node : node.parentElement;
				if (!element) continue;
				const region = element.closest(CANDIDATE_SELECTOR);
				if (!region) continue;
				const text = (region.textContent || "").trim();
				if (!text) continue;
				const index = indexOf(region);
				// One edit can raise several records against the same
				// region; a listener hears it once.
				const key = `${String(index)}\u0000${text}`;
				if (seen[key]) continue;
				seen[key] = true;
				nominate(index, text);
			}
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}

	if (document.body) watch();
	else document.addEventListener("DOMContentLoaded", watch);
};
