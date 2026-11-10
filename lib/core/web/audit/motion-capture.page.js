// Run in the page, sent by motion.ts's MOTION_CAPTURE, which says what it does.
(() => {
	const selectorFor = (el) => {
		if (!el?.tagName) return "(detached)";
		const tag = el.tagName.toLowerCase();
		if (el.id) return `#${el.id}`;
		const hook = el.getAttribute?.("data-testid");
		if (hook) return `${tag}[data-testid="${hook}"]`;
		const first = el.classList?.[0];
		if (first) return `${tag}.${first}`;
		return tag;
	};

	const videos = [...document.querySelectorAll("video")].map((video) => ({
		selector: selectorFor(video),
		html: video.outerHTML.slice(0, 160),
		playing: !video.paused && !video.ended && video.readyState > 2,
		autoplay: video.autoplay,
		loop: video.loop,
		controls: video.controls,
		visible: video.getClientRects().length > 0,
	}));

	const animations = document.getAnimations
		? document.getAnimations({ subtree: true }).map((animation) => {
				const effect = animation.effect;
				const timing = effect?.getTiming ? effect.getTiming() : {};
				const duration =
					typeof timing.duration === "number" ? timing.duration : undefined;
				const target = effect?.target ? effect.target : null;
				return {
					selector: selectorFor(target),
					name:
						animation.animationName ||
						animation.transitionProperty ||
						animation.id ||
						"unnamed",
					kind: animation.constructor.name,
					playState: animation.playState,
					...(duration === undefined ? {} : { durationMs: duration }),
					iterations: String(
						timing.iterations === undefined ? 1 : timing.iterations,
					),
					scroll: !!(
						animation.timeline &&
						animation.timeline.constructor.name !== "DocumentTimeline"
					),
				};
			})
		: [];

	return {
		reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
		videos,
		animations,
	};
})();
