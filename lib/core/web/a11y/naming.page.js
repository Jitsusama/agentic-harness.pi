// Run in the page, sent by walkprobe.ts's NAMING, which says what it does.
// biome-ignore-all lint/correctness/noUnusedVariables: a fragment declares helpers for the probe it is spliced into, which calls them there
const labelled = (el) => {
	const by = el.getAttribute?.("aria-labelledby");
	if (by) {
		const words = by
			.split(/\s+/)
			.map((id) => {
				const source = document.getElementById(id);
				return source ? source.innerText || source.textContent || "" : "";
			})
			.join(" ")
			.trim();
		if (words) return words;
	}
	const labels = el.labels;
	if (labels?.length) {
		return Array.prototype.map
			.call(labels, (label) => label.innerText || label.textContent || "")
			.join(" ")
			.trim();
	}
	return "";
};
const nameOf = (el) =>
	(
		el.getAttribute("aria-label") ||
		labelled(el) ||
		el.innerText ||
		el.value ||
		el.getAttribute("title") ||
		el.getAttribute("alt") ||
		""
	)
		.trim()
		.slice(0, 60);
