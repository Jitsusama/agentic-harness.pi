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
		},
		nodes,
	};
})()`;
}

/**
 * Collect every pointer target on the page with the facts WCAG
 * 2.5.8 needs to judge it.
 *
 * The two exceptions the criterion turns on are both facts about
 * layout that only the browser can settle, so both are measured
 * here rather than guessed from a tag name. A target is inline
 * when the browser lays it out inline inside a run of text, and
 * user-agent controlled when the page sets no size for it.
 */
export const TARGET_CAPTURE = `(() => {
	// Same naming as the visual capture, so a selector in a target
	// finding reads the same as one in a layout finding.
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

	const selector = [
		"a[href]", "button", "input", "select", "textarea", "summary",
		"[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
		"[role=switch]", "[role=tab]", "[role=menuitem]", "[role=option]",
	].join(",");

	const visible = (el) =>
		typeof el.checkVisibility === "function"
			? el.checkVisibility()
			: el.getClientRects().length > 0;

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
	for (const el of document.querySelectorAll(selector)) {
		if (el.disabled) continue;
		if (!visible(el)) continue;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		const style = getComputedStyle(el);
		const id = "t" + index++;
		const target = {
			id,
			selector: selectorFor(el),
			rect: {
				x: rect.x + scrollX, y: rect.y + scrollY,
				width: rect.width, height: rect.height,
			},
		};
		if (inTextFlow(el, style)) target.inline = true;
		targets.push(target);
	}
	return targets;
})()`;
