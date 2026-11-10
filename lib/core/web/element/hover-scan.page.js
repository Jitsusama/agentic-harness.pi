// Run in the page, sent by hover.ts's HOVER_SCAN, which says what it does.
(() => {
	const found = [];
	let unreadableSheets = 0;
	const walk = (list) => {
		for (const rule of list) {
			const selector = rule.selectorText;
			if (typeof selector === "string") {
				for (const part of selector.split(",")) {
					if (/:hover\b/.test(part)) {
						const base = part.replace(/:hover\b/g, "").trim();
						if (base) found.push(base);
					}
				}
			}
			if (rule.cssRules && rule.cssRules.length > 0) walk(rule.cssRules);
		}
	};
	for (const sheet of document.styleSheets) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch {
			unreadableSheets += 1;
			continue;
		}
		walk(rules);
	}
	return JSON.stringify({ selectors: [...new Set(found)], unreadableSheets });
})();
