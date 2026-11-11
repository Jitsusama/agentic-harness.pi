// Run in the page, sent by probe.ts's TARGET_CAPTURE, which says what it does.
({ deepElements, deepSelectorFor }, { presented }) => {
	const selector = [
		"a[href]",
		"button",
		"input",
		"select",
		"textarea",
		"summary",
		"[role=button]",
		"[role=link]",
		"[role=checkbox]",
		"[role=radio]",
		"[role=switch]",
		"[role=tab]",
		"[role=menuitem]",
		"[role=option]",
	].join(",");

	// Inline in the specification's sense: laid out inline, and
	// sitting among text rather than alone in its own block. A
	// link in a sentence is excepted; a link that happens to be
	// display:inline but is the only thing in its parent is not.
	const inTextFlow = (el, style) => {
		if (style.display !== "inline") return false;
		const parent = el.parentElement;
		if (!parent) return false;
		let text = "";
		for (const node of parent.childNodes) {
			if (node.nodeType === 3) text += node.nodeValue || "";
		}
		return text.trim().length > 0;
	};

	// The criterion's other exception, for a control whose size
	// the user agent decides and the author never touched, is not
	// claimed here. Nothing the page can ask distinguishes "the
	// browser chose this size" from "a stylesheet chose it": a
	// first attempt read the inline style attribute, which sees
	// nothing when the size comes from a class, and excepted every
	// undersized button on the fixture. Guessing it wrong excuses
	// real failures, and a well-spaced native control is already
	// excepted by the spacing rule below, so the honest move is to
	// measure what we can and leave this to a person.

	const targets = [];
	let index = 0;
	for (const el of deepElements(document)) {
		if (!el.matches(selector)) continue;
		if (el.disabled) continue;
		// Only things a pointer is actually offered. A control inside
		// a closed dialog is not aimed at, and a screen-reader-only
		// input is operated through its visible label rather than its
		// own one-pixel box: reporting those as undersized targets
		// filed ten failures against a page that has none.
		if (!presented(el)) continue;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		const style = getComputedStyle(el);
		const id = `t${index++}`;
		const target = {
			id,
			selector: deepSelectorFor(el),
			rect: {
				x: rect.x + scrollX,
				y: rect.y + scrollY,
				width: rect.width,
				height: rect.height,
			},
		};
		if (inTextFlow(el, style)) target.inline = true;
		targets.push(target);
	}
	return targets;
};
