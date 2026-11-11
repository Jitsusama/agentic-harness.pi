// Run in the page, sent by probe.ts's visualCaptureSource(), which says what it does.
({ deepElements, deepSelectorFor }, { visible }, { MAX_TEXT }) => {
	const ownText = (el) => {
		let out = "";
		for (const child of el.childNodes) {
			if (child.nodeType === 3) out += child.nodeValue || "";
		}
		return out.trim().slice(0, MAX_TEXT);
	};

	const nodes = [];
	let index = 0;
	for (const el of deepElements(document)) {
		const tag = el.tagName.toLowerCase();
		if (tag === "script" || tag === "style" || tag === "head") continue;
		// Painted at all: the browser's own answer, and the only one
		// that accounts for a display:none ancestor. Visually-hidden
		// idioms are not excluded here, because the layout rules
		// recognise those themselves and want to see them.
		if (!visible(el)) continue;
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		const node = {
			id: `v${index++}`,
			selector: deepSelectorFor(el),
			tag,
			rect: {
				x: rect.x + scrollX,
				y: rect.y + scrollY,
				width: rect.width,
				height: rect.height,
			},
			scrollWidth: el.scrollWidth,
			scrollHeight: el.scrollHeight,
			clientWidth: el.clientWidth,
			clientHeight: el.clientHeight,
			overflowX: style.overflowX,
			overflowY: style.overflowY,
			fontSizePx: Number.parseFloat(style.fontSize) || 0,
			clipPath: style.clipPath,
			// The three properties that separate a deliberate idiom
			// from a defect. Without them the clipping rule cannot
			// tell an ellipsis from an amputation, and the image rule
			// cannot tell a cover crop from a squash, so both fire on
			// most of the real web.
			textOverflow: style.textOverflow,
			lineClamp: style.webkitLineClamp || style.lineClamp || "none",
			objectFit: style.objectFit,
		};
		const text = ownText(el);
		if (text) node.text = text;
		if (tag === "img") {
			node.naturalWidth = el.naturalWidth;
			node.naturalHeight = el.naturalHeight;
			node.complete = el.complete;
			node.src = el.currentSrc || el.src;
		}
		nodes.push(node);
	}

	return {
		viewport: {
			width: innerWidth,
			height: innerHeight,
			documentWidth: document.documentElement.scrollWidth,
			documentHeight: document.documentElement.scrollHeight,
			// The offset the rects above were taken against, so a
			// caller working in viewport coordinates can get back.
			scrollX,
			scrollY,
		},
		nodes,
	};
};
