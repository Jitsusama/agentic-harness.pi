// Run in the page, sent by capture.ts's COMPUTED_STYLE_PROBE, which says what it does.
// biome-ignore lint/suspicious/noUnusedExpressions: the function is the script, handed to the page to call
(function (shorthands) {
	const styles = getComputedStyle(this);
	const out = {};
	for (let i = 0; i < styles.length; i++) {
		const name = styles[i];
		out[name] = styles.getPropertyValue(name);
	}
	for (let j = 0; j < shorthands.length; j++) {
		out[shorthands[j]] = styles.getPropertyValue(shorthands[j]);
	}
	return out;
});
