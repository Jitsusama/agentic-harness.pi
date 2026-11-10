// Run in the page, sent by deep.ts's DEEP_DOM, which says what it does.
// biome-ignore-all lint/correctness/noUnusedVariables: a fragment declares helpers for the probe it is spliced into, which calls them there
const __shadowOf = (el) => {
	try {
		return el.shadowRoot;
	} catch {
		return null;
	}
};
const __docOf = (el) => {
	// Reaching into a cross-origin frame throws by design.
	try {
		return el.contentDocument;
	} catch {
		return null;
	}
};
let __unreachableFrames = 0;
const deepElements = (root) => {
	const out = [];
	const visit = (node) => {
		for (const el of node.querySelectorAll("*")) {
			out.push(el);
			const shadow = __shadowOf(el);
			if (shadow) visit(shadow);
			if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
				const doc = __docOf(el);
				if (doc?.documentElement) visit(doc);
				else __unreachableFrames++;
			}
		}
	};
	visit(root || document);
	return out;
};
const __oneSelector = (el) => {
	const tag = el.tagName.toLowerCase();
	if (el.id) return `#${el.id}`;
	const hook = el.getAttribute("data-testid");
	if (hook) return `${tag}[data-testid="${hook}"]`;
	const first = el.classList?.[0];
	if (first) return `${tag}.${first}`;
	const parent = el.parentElement;
	if (!parent) return tag;
	const kin = [...parent.children].filter((c) => c.tagName === el.tagName);
	if (kin.length === 1) return tag;
	return `${tag}:nth-of-type(${kin.indexOf(el) + 1})`;
};
// Cross a boundary by naming the host, so the path can be
// followed by hand: "my-card >> button".
const deepSelectorFor = (el) => {
	const parts = [__oneSelector(el)];
	let node = el;
	for (let hops = 0; hops < 10; hops++) {
		const root = node.getRootNode ? node.getRootNode() : null;
		const host = root?.host;
		const frame = root?.defaultView?.frameElement;
		const crossing = host || frame;
		if (!crossing) break;
		parts.unshift(__oneSelector(crossing));
		node = crossing;
	}
	return parts.join(" >> ");
};
