// Run in the page, sent by probe.ts's inventorySource(), which says what it does.
({ deepElements, deepSelectorFor }, { presented }, { PROPERTIES }) => {
	const NOTHING = new Set([
		"none",
		"normal",
		"auto",
		"0px",
		"rgba(0, 0, 0, 0)",
		"0px 0px 0px 0px",
	]);

	const samples = [];
	for (const el of deepElements(document)) {
		const tag = el.tagName.toLowerCase();
		if (tag === "script" || tag === "style" || tag === "head") continue;
		// An inventory of what the design actually looks like, so it
		// samples what somebody can actually see: not a closed
		// dialog's contents, and not a screen-reader-only label whose
		// colours nobody ever looks at.
		if (!presented(el)) continue;

		const own = getComputedStyle(el);
		const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;

		// A border colour with no border is not a decision. Its
		// initial value is currentColor, so every element reports
		// one, and sampling them all just echoes the colour list
		// back under a second heading.
		const hasBorder =
			own.borderStyle !== "none" &&
			Number.parseFloat(own.borderTopWidth) +
				Number.parseFloat(own.borderRightWidth) +
				Number.parseFloat(own.borderBottomWidth) +
				Number.parseFloat(own.borderLeftWidth) >
				0;

		const values = {};
		for (const property of PROPERTIES) {
			if (property === "border-color" && !hasBorder) continue;
			const value = own.getPropertyValue(property);
			if (!value || NOTHING.has(value)) continue;
			// Only what this element decided, not what it was handed.
			if (parent && parent.getPropertyValue(property) === value) continue;
			values[property] = value;
		}
		if (Object.keys(values).length === 0) continue;
		samples.push({ selector: deepSelectorFor(el), values });
	}
	return samples;
};
