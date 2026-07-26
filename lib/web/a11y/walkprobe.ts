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

import { DEEP_DOM } from "../snapshot/deep.js";

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
	${DEEP_DOM}
	const selector = [
		"a[href]", "button", "input", "select", "textarea",
		"[tabindex]", "details", "audio[controls]", "video[controls]",
		"[contenteditable]",
	].join(",");
	const modalSelector = ${JSON.stringify(MODAL_SELECTOR)};

	// checkVisibility is the browser's own answer, but only if it
	// is asked the whole question. Bare checkVisibility() reports
	// on display and nothing else: it calls a visibility:hidden
	// control focusable, and a real app hides its closed menus and
	// dialogs that way. Measured on one page: 58 said focusable
	// against 13 that could actually take focus.
	//
	// opacity is deliberately NOT asked about. An opacity:0 control
	// is still in the focus order, so excluding it would bury a
	// real defect: focus landing somewhere invisible. That is the
	// walk's own "no visible focus indicator" finding, and it can
	// only make it if the element survives to be walked.
	const visible = (el) =>
		typeof el.checkVisibility === "function"
			? el.checkVisibility({
					visibilityProperty: true,
					contentVisibilityAuto: true,
				})
			: el.getClientRects().length > 0;

	// inert takes an element out of the focus order without
	// touching how it looks, so no style question finds it. A
	// closed dialog's contents are the ordinary case.
	const inert = (el) =>
		typeof el.closest === "function" && el.closest("[inert]") !== null;

	// The browser's own answer, and the last word: try it. Style
	// rules approximate the focus order, but inertness applied by
	// an open modal is not spelled anywhere in markup, and only an
	// attempt can settle it. Focusing something unfocusable is a
	// no-op, so the only elements this can disturb are the ones the
	// walk is about to tab through anyway, and preventScroll keeps
	// it from moving the page under us.
	const canHoldFocus = (el) => {
		try {
			el.focus({ preventScroll: true });
		} catch (error) {
			return false;
		}
		const root = el.getRootNode();
		return (root.activeElement || document.activeElement) === el;
	};

	// Every focusable thing on the page, including inside open
	// shadow roots and same-origin frames. Reading only the top
	// document reported a design-system page as having no
	// focusable controls at all, which the check then rendered as
	// "Nothing on this page can hold focus".
	// Everything the cheap tests allow, before focus is touched.
	const plausible = deepElements(document).filter((el) => {
		if (!el.matches(selector)) return false;
		if (el.disabled) return false;
		if (el.getAttribute("tabindex") === "-1") return false;
		if (!visible(el)) return false;
		return !inert(el);
	});

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

	// Resting styles are read now, while focus is still wherever the
	// page left it, and BEFORE anything below moves focus. Reading
	// them afterwards records the probe's own focus ring as the
	// element's resting state, and the element then appears to gain
	// nothing when focused: the walk reported the last control in
	// the document as having no focus indicator, on a page where it
	// has a perfectly good one. That is a false accusation of the
	// exact defect this check exists to find, so the ordering here
	// is load-bearing rather than incidental.
	const resting = new Map(plausible.map((el) => [el, styleOf(el)]));

	// Now the authoritative pass. Style rules only approximate the
	// focus order: inertness applied by an open modal is written
	// nowhere in markup, and only an attempt settles it.
	const restoreFocusTo = document.activeElement;
	const focusable = plausible.filter(canHoldFocus);
	try {
		// blur first, so a body that refuses focus still ends up
		// without it rather than leaving the last probe's element
		// focused.
		if (document.activeElement && document.activeElement.blur) {
			document.activeElement.blur();
		}
		if (
			restoreFocusTo &&
			restoreFocusTo !== document.body &&
			typeof restoreFocusTo.focus === "function"
		) {
			restoreFocusTo.focus({ preventScroll: true });
		}
	} catch (error) {
		// Whatever held focus has gone or refuses it; the walk sets
		// focus from the top anyway, so this is not worth failing on.
	}

	window.__walkCandidates = focusable;

	const candidates = focusable.map((el, index) => {
		const tabindex = el.getAttribute("tabindex");
		return {
			index, tag: el.tagName, name: nameOf(el),
			...(el.id ? { id: el.id } : {}),
			...(el.getAttribute("role") ? { role: el.getAttribute("role") } : {}),
			...(tabindex === null ? {} : { tabindex: Number(tabindex) }),
			...(inModal(el) ? { inModal: true } : {}),
			resting: resting.get(el) || styleOf(el),
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
	// Structure, not controls. A handler on one of these is
	// delegation or an outside-click listener rather than a promise
	// that it can be operated.
	const CONTAINER_TAGS = new Set([
		"NAV", "HEADER", "FOOTER", "SECTION", "ARTICLE", "ASIDE",
		"FORM", "UL", "OL", "TABLE", "TBODY", "TR", "DIALOG",
	]);
	// Where a framework hangs its delegated click handler. A root
	// carrying one is not a control that forgot to be focusable, it
	// is how React, Vue and Svelte deliver every event they have, so
	// flagging it says nothing except that the page uses a
	// framework. It read especially badly: the finding named the
	// element by its text, so the whole header bled into the label,
	// and on a real app this single false positive was the only
	// thing failing the keyboard check.
	const DELEGATES = new Set(["HTML", "BODY", "MAIN", "#document"]);

	const reachable = new Set(focusable);
	const unreachable = [];
	for (const el of deepElements(document)) {
		if (reachable.has(el)) continue;
		if (DELEGATES.has(el.tagName)) continue;
		const role = el.getAttribute("role");
		const hasRole = role && interactiveRoles.has(role);
		const hasHandler = typeof el.onclick === "function";
		if (!hasRole && !hasHandler) continue;
		// A landmark or a section is a container, not a control, even
		// when something has attached a handler to it.
		if (hasHandler && !hasRole && CONTAINER_TAGS.has(el.tagName)) continue;
		if (!visible(el)) continue;
		// An inert control is not being offered to anybody yet: the
		// closed search dialog's inputs are inert, look perfectly
		// visible, and tab is right not to reach them. Complaining
		// here would blame a page for a dialog that is shut.
		if (inert(el)) continue;
		unreachable.push({
			tag: el.tagName, name: nameOf(el), selector: deepSelectorFor(el),
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
	// document.activeElement stops at a shadow host: focus inside a
	// component reports as the custom element, not the control. So
	// the walk collected four candidates in a design system and
	// then matched none of them, reporting zero stops. Descend to
	// the element that really has focus.
	let el = document.activeElement;
	for (let hops = 0; hops < 10; hops++) {
		const inner = el && el.shadowRoot && el.shadowRoot.activeElement;
		if (!inner) break;
		el = inner;
	}
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
 *
 * Paired with WALK_RESTORE below, which puts both back.
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
