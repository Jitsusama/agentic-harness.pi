// Run in the page, sent by walkprobe.ts's WALK_READ, which says what it does.
({ nameOf }, { modalSelector }) => {
	// document.activeElement stops at a shadow host: focus inside a
	// component reports as the custom element, not the control. So
	// the walk collected four candidates in a design system and
	// then matched none of them, reporting zero stops. Descend to
	// the element that really has focus.
	let el = document.activeElement;
	for (let hops = 0; hops < 10; hops++) {
		const inner = el?.shadowRoot?.activeElement;
		if (!inner) break;
		el = inner;
	}
	const list = globalThis.__walkCandidates || [];
	if (!el || el === document.body || el === document.documentElement) {
		return {
			index: -1,
			tag: el ? el.tagName : "NONE",
			name: "",
			inViewport: false,
			focused: null,
		};
	}
	const visibleNow = (node) =>
		typeof node.checkVisibility === "function"
			? node.checkVisibility({
					visibilityProperty: true,
					contentVisibilityAuto: true,
				})
			: node.getClientRects().length > 0;
	const c = getComputedStyle(el);
	const box = el.getBoundingClientRect();
	return {
		index: list.indexOf(el),
		tag: el.tagName,
		...(el.id ? { id: el.id } : {}),
		name: nameOf(el),
		// Where it is, and whether the browser paints it: two
		// questions, asked separately. Requiring the element's own
		// box to have width and height conflated them, and an anchor
		// whose only child is floated measures 35 by 0 while the text
		// inside it is plainly on the page. Twenty-seven of those on
		// one article were each reported as focus landing off screen.
		// The census already trusts checkVisibility for exactly this
		// question; the stop reader was the one place that did not.
		inViewport:
			box.bottom >= 0 &&
			box.right >= 0 &&
			box.top <= innerHeight &&
			box.left <= innerWidth &&
			visibleNow(el),
		// Kept so tab order can be compared against the order things
		// are read in, which document order cannot answer.
		rect: { x: box.left, y: box.top, width: box.width, height: box.height },
		...(el.closest(modalSelector) !== null ? { inModal: true } : {}),
		focused: {
			outlineStyle: c.outlineStyle,
			outlineWidth: c.outlineWidth,
			outlineColor: c.outlineColor,
			boxShadow: c.boxShadow,
			backgroundColor: c.backgroundColor,
			borderColor: c.borderColor,
			color: c.color,
		},
	};
};
