// Run in the page, sent by capture.ts's INITIALS_PROBE, which says what it does.
(shorthands) => {
	const host = document.createElement("div");
	host.style.setProperty("all", "initial");
	document.documentElement.appendChild(host);
	const styles = getComputedStyle(host);
	const out = {};
	for (let i = 0; i < styles.length; i++) {
		const name = styles[i];
		out[name] = styles.getPropertyValue(name);
	}
	for (let j = 0; j < shorthands.length; j++) {
		out[shorthands[j]] = styles.getPropertyValue(shorthands[j]);
	}
	host.remove();
	return out;
};
