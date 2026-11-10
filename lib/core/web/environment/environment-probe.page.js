// Run in the page, sent by probes.ts's ENVIRONMENT_PROBE, which says what it does.
(() => {
	const on = (query) => globalThis.matchMedia(query).matches;
	const pick = (name, values, fallback) => {
		for (const value of values) {
			if (on(`(${name}: ${value})`)) return value;
		}
		return fallback;
	};
	return {
		colorScheme: pick("prefers-color-scheme", ["dark", "light"], "light"),
		reducedMotion: on("(prefers-reduced-motion: reduce)"),
		contrast: pick(
			"prefers-contrast",
			["more", "less", "custom"],
			"no-preference",
		),
		forcedColors: on("(forced-colors: active)"),
		print: on("print"),
		width: globalThis.innerWidth,
		height: globalThis.innerHeight,
		devicePixelRatio: globalThis.devicePixelRatio,
		maxTouchPoints: navigator.maxTouchPoints,
		touchEvents: "ontouchstart" in globalThis,
		language: navigator.language,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
})();
