/**
 * Asking the page what its layout did.
 *
 * Every number here is one the browser computed: bounding
 * rectangles, scroll against client dimensions, the resolved
 * overflow, an image's own size. None of it is derived from CSS
 * text, because the CSS is not what happened, the layout is.
 *
 * It ships as a source string because it declares helpers, and
 * the bundler rewrites named inner bindings through a wrapper
 * the page does not have.
 */

/** How much text to carry back per element. */
const MAX_TEXT = 120;

/**
 * Build the expression that collects the layout capture.
 *
 * Only elements the browser actually drew are collected, since
 * a rule about how something looks has nothing to say about
 * something that was never painted.
 */
export function visualCaptureSource(): string {
	return `(() => {
	const MAX_TEXT = ${MAX_TEXT};

	const ownText = (el) => {
		let out = "";
		for (const child of el.childNodes) {
			if (child.nodeType === 3) out += child.nodeValue || "";
		}
		return out.trim().slice(0, MAX_TEXT);
	};

	const selectorFor = (el) => {
		const tag = el.tagName.toLowerCase();
		if (el.id) return "#" + el.id;
		const hook = el.getAttribute("data-testid");
		if (hook) return tag + '[data-testid="' + hook + '"]';
		const first = el.classList[0];
		if (first) return tag + "." + first;
		const parent = el.parentElement;
		if (!parent) return tag;
		const kin = [...parent.children].filter((c) => c.tagName === el.tagName);
		if (kin.length === 1) return tag;
		return tag + ":nth-of-type(" + (kin.indexOf(el) + 1) + ")";
	};

	const nodes = [];
	let index = 0;
	for (const el of document.querySelectorAll("*")) {
		const tag = el.tagName.toLowerCase();
		if (tag === "script" || tag === "style" || tag === "head") continue;
		// checkVisibility is the browser's own answer, and the only
		// one that accounts for a display:none ancestor.
		if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
			continue;
		}
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		const node = {
			id: "v" + index++,
			selector: selectorFor(el),
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
		},
		nodes,
	};
})()`;
}
