// Run in the page, sent by focus.ts's FOCUS_PROBE, which says what it does.
(() => {
	const active = () => {
		// Focus inside a shadow root reads as the host from outside, so
		// the chain is followed down to the element that really has it.
		let el = document.activeElement;
		let shadowed = false;
		while (el?.shadowRoot?.activeElement) {
			el = el.shadowRoot.activeElement;
			shadowed = true;
		}
		return { el, shadowed };
	};

	const found = active();
	const el = found.el;
	if (!el) return undefined;

	const tag = el.tagName ? el.tagName.toLowerCase() : "unknown";
	const onBody = el === document.body || tag === "html";
	const labelled = () => {
		const aria = el.getAttribute?.("aria-label");
		if (aria) return aria.trim();
		const by = el.getAttribute?.("aria-labelledby");
		if (by) {
			const names = by.split(/\s+/).map((id) => {
				const target = document.getElementById(id);
				return target ? (target.textContent || "").trim() : "";
			});
			const joined = names.filter(Boolean).join(" ");
			if (joined) return joined;
		}
		if (el.labels && el.labels.length > 0) {
			return (el.labels[0].textContent || "").trim();
		}
		const own = (el.textContent || "").replace(/\s+/g, " ").trim();
		if (own) return own.slice(0, 80);
		const value = el.getAttribute?.("value");
		return value ? value.trim() : "";
	};

	const box = el.getBoundingClientRect ? el.getBoundingClientRect() : undefined;
	const name = onBody ? "" : labelled();
	const role = el.getAttribute?.("role");
	return {
		tag,
		role: role || undefined,
		name: name || undefined,
		id: el.id || undefined,
		onBody,
		inShadow: found.shadowed || undefined,
		rect:
			box && (box.width > 0 || box.height > 0)
				? { x: box.x, y: box.y, width: box.width, height: box.height }
				: undefined,
	};
})();
