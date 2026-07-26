/**
 * The page-side half of the keyboard walk.
 *
 * These ship as source strings because they declare helpers of
 * their own, and the bundler renames every named inner binding
 * through a wrapper the page has never heard of. A function
 * handed over as a value would throw before it registered
 * anything, silently.
 */

/**
 * What counts as a modal, from the page's own point of view.
 *
 * A dialog that contains focus is doing its job, and a keyboard
 * checker that cannot tell that from a dead end reports the
 * reference implementation of the pattern as the defect it
 * exists to find.
 */
const MODAL_SELECTOR =
	'dialog[open], [role="dialog"][aria-modal="true"], ' +
	'[role="alertdialog"][aria-modal="true"]';

/**
 * Collect everything the browser will let focus land on, and
 * remember what each looks like at rest.
 *
 * The list is deliberately built from the browser's own view: an
 * element that is display:none or disabled is not focusable no
 * matter what its markup says, and asking the computed style is
 * the only way to know.
 */
export const WALK_COLLECT = `(() => {
	const selector = [
		"a[href]", "button", "input", "select", "textarea",
		"[tabindex]", "details", "audio[controls]", "video[controls]",
		"[contenteditable]",
	].join(",");
	const modalSelector = ${JSON.stringify(MODAL_SELECTOR)};

	// checkVisibility is the browser's own answer, and the only
	// one that is right here. An element inside a display:none
	// parent reports its own display, not none, so asking the
	// computed style calls a hidden dialog's buttons focusable.
	const visible = (el) =>
		typeof el.checkVisibility === "function"
			? el.checkVisibility()
			: el.getClientRects().length > 0;

	const focusable = [...document.querySelectorAll(selector)].filter((el) => {
		if (el.disabled) return false;
		if (el.getAttribute("tabindex") === "-1") return false;
		return visible(el);
	});

	window.__walkCandidates = focusable;

	const styleOf = (el) => {
		const c = getComputedStyle(el);
		return {
			outlineStyle: c.outlineStyle, outlineWidth: c.outlineWidth,
			outlineColor: c.outlineColor, boxShadow: c.boxShadow,
			backgroundColor: c.backgroundColor, borderColor: c.borderColor,
			color: c.color,
		};
	};
	const nameOf = (el) =>
		(el.getAttribute("aria-label") || el.innerText || el.value ||
			el.getAttribute("title") || el.getAttribute("alt") || "").trim().slice(0, 60);
	const inModal = (el) => el.closest(modalSelector) !== null;

	const candidates = focusable.map((el, index) => {
		const tabindex = el.getAttribute("tabindex");
		return {
			index, tag: el.tagName, name: nameOf(el),
			...(el.id ? { id: el.id } : {}),
			...(el.getAttribute("role") ? { role: el.getAttribute("role") } : {}),
			...(tabindex === null ? {} : { tabindex: Number(tabindex) }),
			...(inModal(el) ? { inModal: true } : {}),
			resting: styleOf(el),
		};
	});

	// Anything that behaves like a control without being one. An
	// interactive role is a promise to the reader; not being
	// focusable breaks it.
	//
	// The handler test only sees an inline onclick. A framework
	// that delegates from the root, which is every React, Vue and
	// Svelte page, registers nothing this can read, and there is
	// no cheap document-wide way to ask. So the reason string says
	// what was actually checked rather than implying more, and the
	// verdict reports the limit instead of letting silence read as
	// coverage.
	const interactiveRoles = new Set([
		"button", "link", "checkbox", "radio", "switch", "tab",
		"menuitem", "option", "slider", "textbox",
	]);
	const reachable = new Set(focusable);
	const unreachable = [];
	for (const el of document.querySelectorAll("*")) {
		if (reachable.has(el)) continue;
		const role = el.getAttribute("role");
		const hasRole = role && interactiveRoles.has(role);
		const hasHandler = typeof el.onclick === "function";
		if (!hasRole && !hasHandler) continue;
		if (!visible(el)) continue;
		unreachable.push({
			tag: el.tagName, name: nameOf(el),
			...(role ? { role } : {}),
			because: hasRole
				? "carries role " + role + " but nothing can focus it"
				: "has an inline click handler but nothing can focus it",
		});
	}

	return { candidates, unreachable };
})()`;

/**
 * Read where focus is now.
 *
 * The index is looked up against the same array the collection
 * pass stored, so identity is the element itself rather than a
 * selector that might match twice.
 */
export const WALK_READ = `(() => {
	const el = document.activeElement;
	const list = window.__walkCandidates || [];
	const modalSelector = ${JSON.stringify(MODAL_SELECTOR)};
	if (!el || el === document.body || el === document.documentElement) {
		return { index: -1, tag: el ? el.tagName : "NONE", name: "",
			inViewport: false, focused: null };
	}
	const c = getComputedStyle(el);
	const box = el.getBoundingClientRect();
	return {
		index: list.indexOf(el),
		tag: el.tagName,
		...(el.id ? { id: el.id } : {}),
		name: (el.getAttribute("aria-label") || el.innerText || el.value ||
			el.getAttribute("title") || "").trim().slice(0, 60),
		inViewport: box.bottom > 0 && box.right > 0 &&
			box.top < innerHeight && box.left < innerWidth &&
			box.width > 0 && box.height > 0,
		...(el.closest(modalSelector) !== null ? { inModal: true } : {}),
		focused: {
			outlineStyle: c.outlineStyle, outlineWidth: c.outlineWidth,
			outlineColor: c.outlineColor, boxShadow: c.boxShadow,
			backgroundColor: c.backgroundColor, borderColor: c.borderColor,
			color: c.color,
		},
	};
})()`;

/**
 * Remember where focus and the viewport were before the walk.
 *
 * The walk is one of the two reads that deliberately change the
 * page, so it owes the caller the page it was handed back. Tab
 * scrolls each stop into view, and the health digest runs the
 * keyboard check before the visual, performance and design ones,
 * so a walk that leaves the page scrolled moves the ground under
 * every measurement that follows it in the same run.
 */
export const WALK_REMEMBER = `(() => {
	window.__walkOrigin = {
		el: document.activeElement,
		x: window.scrollX,
		y: window.scrollY,
	};
	return true;
})()`;

/** Put focus and the scroll position back where the walk found them. */
export const WALK_RESTORE = `(() => {
	const origin = window.__walkOrigin;
	if (document.activeElement && document.activeElement.blur) {
		document.activeElement.blur();
	}
	if (origin) {
		const el = origin.el;
		// Refocusing only makes sense if it is still in the document
		// and could hold focus in the first place; body cannot.
		if (el && el.isConnected && typeof el.focus === "function" &&
			el !== document.body && el !== document.documentElement) {
			try { el.focus({ preventScroll: true }); } catch { /* gone */ }
		}
		window.scrollTo(origin.x, origin.y);
	}
	window.__walkOrigin = undefined;
	window.__walkCandidates = undefined;
	return true;
})()`;
