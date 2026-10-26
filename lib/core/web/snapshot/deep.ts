/**
 * Walking a page the way it is actually built.
 *
 * `document.querySelectorAll` stops at a shadow boundary and at
 * a frame boundary, which means a probe using it sees a design
 * system's markup as a row of empty custom elements. Measured on
 * a two-component page: the flattened snapshot reports eighteen
 * elements and this reported five, so the visual, design, target
 * and keyboard captures each answered questions about a page
 * that was mostly not there. The DOM snapshot pierces both, so
 * the same library was answering the same question two ways.
 *
 * These are source strings rather than functions because they
 * are injected into the page, and the bundler renames named
 * inner bindings through a wrapper the page has never heard of.
 *
 * Same-origin only, for frames. A cross-origin iframe runs in
 * another process and its document is unreachable from page
 * script; nothing here can change that, so the count of frames
 * that could not be entered is reported rather than hidden.
 */

/**
 * Declares `deepElements(root)` and `deepSelectorFor(el)`.
 *
 * `deepElements` returns every element under a root, descending
 * through open shadow roots and same-origin frames. Closed
 * shadow roots are not reachable by anyone, including us.
 *
 * `deepSelectorFor` names an element so a reader can find it
 * again, crossing boundaries with the `>>` that Playwright and
 * devtools both use: `my-card >> button` says the button lives
 * inside that component's shadow root.
 */
export const DEEP_DOM = `
	const __shadowOf = (el) => {
		try { return el.shadowRoot; } catch { return null; }
	};
	const __docOf = (el) => {
		// Reaching into a cross-origin frame throws by design.
		try { return el.contentDocument; } catch { return null; }
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
					if (doc && doc.documentElement) visit(doc);
					else __unreachableFrames++;
				}
			}
		};
		visit(root || document);
		return out;
	};
	const __oneSelector = (el) => {
		const tag = el.tagName.toLowerCase();
		if (el.id) return "#" + el.id;
		const hook = el.getAttribute("data-testid");
		if (hook) return tag + '[data-testid="' + hook + '"]';
		const first = el.classList && el.classList[0];
		if (first) return tag + "." + first;
		const parent = el.parentElement;
		if (!parent) return tag;
		const kin = [...parent.children].filter((c) => c.tagName === el.tagName);
		if (kin.length === 1) return tag;
		return tag + ":nth-of-type(" + (kin.indexOf(el) + 1) + ")";
	};
	// Cross a boundary by naming the host, so the path can be
	// followed by hand: "my-card >> button".
	const deepSelectorFor = (el) => {
		const parts = [__oneSelector(el)];
		let node = el;
		for (let hops = 0; hops < 10; hops++) {
			const root = node.getRootNode ? node.getRootNode() : null;
			const host = root && root.host;
			const frame = root && root.defaultView && root.defaultView.frameElement;
			const crossing = host || frame;
			if (!crossing) break;
			parts.unshift(__oneSelector(crossing));
			node = crossing;
		}
		return parts.join(" >> ");
	};
`;

/** How many frames the page would not let a probe enter. */
export const DEEP_UNREACHABLE = "__unreachableFrames";
