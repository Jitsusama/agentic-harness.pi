/**
 * Whether the page honours a request for reduced motion.
 *
 * The preference is the one accessibility setting a page can
 * ignore without failing a single axe rule: the markup is fine,
 * the contrast is fine, and the page is still unusable for the
 * person who asked it to hold still. The only way to know is to
 * ask for reduce and then look at what is still moving, which is
 * what this module judges from a capture taken under emulation.
 *
 * The analysis is pure and takes serialized data, like every
 * other audit here: nothing in this file can start a browser.
 *
 * Adapted from the reduced-motion conventions in Carolyn
 * McNeillie's review-page skill set, which treats a page that
 * ignores the preference outright as one of the few
 * symptom-only blockers: user-observable, confirmed from the
 * capture, no mechanism claim required.
 */

import type { A11yFinding, FindingNode } from "./axe.ts";

/** A video as the page reported it under reduce. */
export interface MotionVideo {
	readonly selector: string;
	readonly html: string;
	readonly playing: boolean;
	readonly autoplay: boolean;
	readonly loop: boolean;
	readonly controls: boolean;
	readonly visible: boolean;
}

/** An animation as the page reported it under reduce. */
export interface MotionAnimation {
	readonly selector: string;
	readonly name: string;
	readonly kind: string;
	readonly playState: string;
	/** May be absent when the effect reports no timing. */
	readonly durationMs?: number;
	/**
	 * Repeats, as text: Infinity does not survive serialization,
	 * so the page sends the word.
	 */
	readonly iterations: string;
	/** Driven by scroll rather than by time. */
	readonly scroll: boolean;
}

/** What the page was doing while asked to hold still. */
export interface MotionCapture {
	/** Whether the page actually saw the reduce preference. */
	readonly reduced: boolean;
	readonly videos: readonly MotionVideo[];
	readonly animations: readonly MotionAnimation[];
}

/**
 * Animations at or under this total runtime are left alone.
 *
 * The preference asks for less motion, not none: a brief fade is
 * how a page avoids a jarring pop, and flagging every 150ms
 * transition would bury the marquee that never stops.
 */
export const BRIEF_MS = 250;

/**
 * Motion running longer than this needs a way to stop.
 *
 * The five second line is WCAG 2.2.2's own: moving content that
 * starts automatically and lasts longer than five seconds must
 * have a mechanism to pause, stop or hide it.
 */
export const PAUSE_STOP_HIDE_MS = 5000;

/** Total runtime, or none for an animation that never ends. */
function totalMs(animation: MotionAnimation): number | undefined {
	if (animation.iterations === "Infinity") return undefined;
	if (animation.durationMs === undefined) return undefined;
	const repeats = Number(animation.iterations);
	if (!Number.isFinite(repeats)) return undefined;
	return animation.durationMs * repeats;
}

function videoNode(video: MotionVideo, message: string): FindingNode {
	return { selector: video.selector, html: video.html, messages: [message] };
}

function animationNode(
	animation: MotionAnimation,
	message: string,
): FindingNode {
	return {
		selector: animation.selector,
		html: "",
		messages: [message],
	};
}

/**
 * Judge a capture taken under reduced motion.
 *
 * An empty answer from a capture where the page never saw the
 * preference would be a lie, so a capture with reduced false
 * produces a single needs-review finding naming the problem
 * instead of a clean pass.
 */
export function analyseMotion(capture: MotionCapture): readonly A11yFinding[] {
	if (!capture.reduced) {
		return [
			{
				rule: "reduced-motion-not-emulated",
				kind: "needs-review",
				impact: "moderate",
				authority: "best-practice",
				criteria: [],
				levels: [],
				help:
					"The page never saw prefers-reduced-motion: reduce, so " +
					"nothing here was judged. The emulation did not take; " +
					"nothing can be said about how the page behaves for a " +
					"person who asked it to hold still.",
				nodes: [],
			},
		];
	}

	const findings: A11yFinding[] = [];

	const playing = capture.videos.filter(
		(video) => video.visible && video.playing,
	);
	const unstoppable = playing.filter((video) => !video.controls);
	if (unstoppable.length > 0) {
		findings.push({
			rule: "video-plays-under-reduced-motion",
			kind: "violation",
			impact: "serious",
			authority: "wcag",
			criteria: ["2.2.2"],
			levels: ["A"],
			help:
				"Video still playing with no controls while the page was " +
				"asked for reduced motion. Auto-playing movement that " +
				"cannot be paused, stopped or hidden fails 2.2.2, and " +
				"playing it at all ignores the stated preference.",
			nodes: unstoppable.map((video) =>
				videoNode(
					video,
					video.loop
						? "playing on a loop, no controls to stop it"
						: "playing, no controls to stop it",
				),
			),
		});
	}

	const pausable = playing.filter((video) => video.controls);
	if (pausable.length > 0) {
		findings.push({
			rule: "video-ignores-reduced-motion",
			kind: "violation",
			impact: "moderate",
			authority: "best-practice",
			criteria: [],
			levels: [],
			help:
				"Video plays automatically under reduced motion. It has " +
				"controls, so 2.2.2 is met, but the preference asked the " +
				"page not to start the motion in the first place.",
			nodes: pausable.map((video) => videoNode(video, "autoplays")),
		});
	}

	const running = capture.animations.filter(
		(animation) => animation.playState === "running",
	);

	const scrollDriven = running.filter((animation) => animation.scroll);
	if (scrollDriven.length > 0) {
		findings.push({
			rule: "scroll-animation-under-reduced-motion",
			kind: "violation",
			impact: "moderate",
			authority: "wcag",
			criteria: ["2.3.3"],
			levels: ["AAA"],
			help:
				"Scroll-driven animation still active under reduced " +
				"motion. Motion triggered by interaction is exactly what " +
				"2.3.3 says the preference should disable.",
			nodes: scrollDriven.map((animation) =>
				animationNode(animation, `${animation.name} rides the scroll`),
			),
		});
	}

	const timed = running.filter((animation) => !animation.scroll);
	const endlessOrLong = timed.filter((animation) => {
		const total = totalMs(animation);
		return total === undefined || total > PAUSE_STOP_HIDE_MS;
	});
	if (endlessOrLong.length > 0) {
		findings.push({
			rule: "animation-runs-under-reduced-motion",
			kind: "violation",
			impact: "serious",
			authority: "wcag",
			criteria: ["2.2.2"],
			levels: ["A"],
			help:
				"Animation still running past the five second line while " +
				"the page was asked for reduced motion. Moving content " +
				"that starts on its own and runs this long needs a way to " +
				"pause, stop or hide it, and honouring the preference is " +
				"the way that costs nothing.",
			nodes: endlessOrLong.map((animation) =>
				animationNode(
					animation,
					animation.iterations === "Infinity"
						? `${animation.name} never ends`
						: `${animation.name} runs ${Math.round(
								(totalMs(animation) ?? 0) / 1000,
							)}s`,
				),
			),
		});
	}

	const brief = timed.filter((animation) => {
		const total = totalMs(animation);
		return (
			total !== undefined && total > BRIEF_MS && total <= PAUSE_STOP_HIDE_MS
		);
	});
	if (brief.length > 0) {
		findings.push({
			rule: "animation-under-reduced-motion",
			kind: "violation",
			impact: "minor",
			authority: "best-practice",
			criteria: [],
			levels: [],
			help:
				"Animation still running under reduced motion. Each one " +
				"ends on its own, so no standard is failed; the preference " +
				"still asked for less of this.",
			nodes: brief.map((animation) =>
				animationNode(
					animation,
					`${animation.name} runs ${totalMs(animation)}ms`,
				),
			),
		});
	}

	return findings;
}

/**
 * The expression that reads what is moving, run in the page
 * while reduce is emulated.
 *
 * Selectors are built the same way the other captures build
 * them: something a person could paste into the console, never a
 * retained node.
 */
export const MOTION_CAPTURE = `(() => {
	const selectorFor = (el) => {
		if (!el || !el.tagName) return "(detached)";
		const tag = el.tagName.toLowerCase();
		if (el.id) return "#" + el.id;
		const hook = el.getAttribute && el.getAttribute("data-testid");
		if (hook) return tag + '[data-testid="' + hook + '"]';
		const first = el.classList && el.classList[0];
		if (first) return tag + "." + first;
		return tag;
	};

	const videos = [...document.querySelectorAll("video")].map((video) => ({
		selector: selectorFor(video),
		html: video.outerHTML.slice(0, 160),
		playing:
			!video.paused && !video.ended && video.readyState > 2,
		autoplay: video.autoplay,
		loop: video.loop,
		controls: video.controls,
		visible: video.getClientRects().length > 0,
	}));

	const animations = document.getAnimations
		? document.getAnimations({ subtree: true }).map((animation) => {
				const effect = animation.effect;
				const timing = effect && effect.getTiming ? effect.getTiming() : {};
				const duration =
					typeof timing.duration === "number" ? timing.duration : undefined;
				const target = effect && effect.target ? effect.target : null;
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
					iterations: String(timing.iterations === undefined ? 1 : timing.iterations),
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
})()`;
