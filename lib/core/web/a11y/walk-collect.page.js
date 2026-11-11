// Run in the page, sent by walkprobe.ts's WALK_COLLECT, which says what it does.
({ deepElements, deepSelectorFor }, { nameOf }, { modalSelector }) => {
	const selector = [
		"a[href]",
		"button",
		"input",
		"select",
		"textarea",
		"[tabindex]",
		"details",
		"summary",
		"audio[controls]",
		"video[controls]",
		"[contenteditable]",
	].join(",");

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
		} catch {
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
			outlineStyle: c.outlineStyle,
			outlineWidth: c.outlineWidth,
			outlineColor: c.outlineColor,
			boxShadow: c.boxShadow,
			backgroundColor: c.backgroundColor,
			borderColor: c.borderColor,
			color: c.color,
		};
	};
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
		if (document.activeElement?.blur) {
			document.activeElement.blur();
		}
		if (
			restoreFocusTo &&
			restoreFocusTo !== document.body &&
			typeof restoreFocusTo.focus === "function"
		) {
			restoreFocusTo.focus({ preventScroll: true });
		}
	} catch {
		// Whatever held focus has gone or refuses it; the walk sets
		// focus from the top anyway, so this is not worth failing on.
	}

	globalThis.__walkCandidates = focusable;

	// Tab stops once in a named radio group, on its checked radio or
	// else its first, and arrow keys move within it. Its other radios
	// can hold focus and are rightly never tabbed to.
	const groupOf = (el) =>
		el.tagName === "INPUT" && el.type === "radio" && el.name
			? `radio ${el.form ? `${deepSelectorFor(el.form)} ` : ""}${el.name}`
			: undefined;

	const candidates = focusable.map((el, index) => {
		const tabindex = el.getAttribute("tabindex");
		return {
			index,
			tag: el.tagName,
			name: nameOf(el),
			...(el.id ? { id: el.id } : {}),
			...(el.getAttribute("role") ? { role: el.getAttribute("role") } : {}),
			...(tabindex === null ? {} : { tabindex: Number(tabindex) }),
			...(inModal(el) ? { inModal: true } : {}),
			...(groupOf(el) ? { group: groupOf(el) } : {}),
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
		"button",
		"link",
		"checkbox",
		"radio",
		"switch",
		"tab",
		"menuitem",
		"option",
		"slider",
		"textbox",
	]);
	// Structure, not controls. A handler on one of these is
	// delegation or an outside-click listener rather than a promise
	// that it can be operated.
	const CONTAINER_TAGS = new Set([
		"NAV",
		"HEADER",
		"FOOTER",
		"SECTION",
		"ARTICLE",
		"ASIDE",
		"FORM",
		"UL",
		"OL",
		"TABLE",
		"TBODY",
		"TR",
		"DIALOG",
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

	// Widgets a keyboard enters with one Tab and moves through with
	// arrow keys: a roving tabindex leaves every item but one at -1,
	// and active-descendant focuses the widget itself. An item of one
	// that a Tab reaches is reached, as a radiogroup's unchecked
	// radios are.
	const COMPOSITE = [
		"radiogroup",
		"tablist",
		"menu",
		"menubar",
		"listbox",
		"tree",
		"treegrid",
		"grid",
		"toolbar",
	]
		.map((role) => `[role="${role}"]`)
		.join(",");
	const reachable = new Set(focusable);
	const enteredByTab = (el) => {
		const widget = el.closest(COMPOSITE);
		if (!widget) return false;
		if (reachable.has(widget)) return true;
		for (const one of reachable) if (widget.contains(one)) return true;
		return false;
	};
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
		if (enteredByTab(el)) continue;
		unreachable.push({
			tag: el.tagName,
			name: nameOf(el),
			selector: deepSelectorFor(el),
			...(role ? { role } : {}),
			because: hasRole
				? `carries role ${role} but nothing can focus it`
				: "has an inline click handler but nothing can focus it",
		});
	}

	return { candidates, unreachable };
};
