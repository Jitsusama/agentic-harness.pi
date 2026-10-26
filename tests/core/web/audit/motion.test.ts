/**
 * Judging what a page kept doing when asked to hold still.
 */

import { describe, expect, it } from "vitest";
import {
	analyseMotion,
	BRIEF_MS,
	type MotionAnimation,
	type MotionCapture,
	type MotionVideo,
	PAUSE_STOP_HIDE_MS,
} from "../../../../lib/core/web/audit/motion.ts";

const video = (over: Partial<MotionVideo> = {}): MotionVideo => ({
	selector: "video.hero",
	html: "<video autoplay loop muted></video>",
	playing: true,
	autoplay: true,
	loop: true,
	controls: false,
	visible: true,
	...over,
});

const animation = (over: Partial<MotionAnimation> = {}): MotionAnimation => ({
	selector: "div.spinner",
	name: "spin",
	kind: "CSSAnimation",
	playState: "running",
	durationMs: 1000,
	iterations: "Infinity",
	scroll: false,
	...over,
});

const capture = (over: Partial<MotionCapture> = {}): MotionCapture => ({
	reduced: true,
	videos: [],
	animations: [],
	...over,
});

const rules = (found: MotionCapture) =>
	analyseMotion(found).map((one) => one.rule);

describe("analyseMotion", () => {
	it("passes a page that held still", () => {
		expect(analyseMotion(capture())).toEqual([]);
	});

	it("will not judge a capture the preference never reached", () => {
		// An empty answer here would read as a pass the page had not
		// earned: nothing was judged, and the finding says so.
		const findings = analyseMotion(capture({ reduced: false }));
		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toBe("reduced-motion-not-emulated");
		expect(findings[0]?.kind).toBe("needs-review");
	});

	it("fails a video playing with no way to stop it", () => {
		const findings = analyseMotion(capture({ videos: [video()] }));
		const failed = findings.find(
			(one) => one.rule === "video-plays-under-reduced-motion",
		);
		expect(failed?.authority).toBe("wcag");
		expect(failed?.criteria).toContain("2.2.2");
		expect(failed?.impact).toBe("serious");
	});

	it("softens to advice when the video has controls", () => {
		// A pause mechanism satisfies 2.2.2; ignoring the preference
		// is still worth saying, but it is advice, not a failure.
		const found = capture({ videos: [video({ controls: true })] });
		expect(rules(found)).toEqual(["video-ignores-reduced-motion"]);
		expect(analyseMotion(found)[0]?.authority).toBe("best-practice");
	});

	it("ignores a video that is not playing", () => {
		expect(rules(capture({ videos: [video({ playing: false })] }))).toEqual([]);
	});

	it("ignores a video nobody can see", () => {
		expect(rules(capture({ videos: [video({ visible: false })] }))).toEqual([]);
	});

	it("fails an animation that never ends", () => {
		const findings = analyseMotion(capture({ animations: [animation()] }));
		const failed = findings.find(
			(one) => one.rule === "animation-runs-under-reduced-motion",
		);
		expect(failed?.criteria).toContain("2.2.2");
		expect(failed?.nodes[0]?.messages[0]).toContain("never ends");
	});

	it("fails a finite animation that outruns the five second line", () => {
		const long = animation({ durationMs: 3000, iterations: "2" });
		expect(rules(capture({ animations: [long] }))).toEqual([
			"animation-runs-under-reduced-motion",
		]);
	});

	it("advises on an animation that ends inside the line", () => {
		const brief = animation({ durationMs: 1000, iterations: "1" });
		const findings = analyseMotion(capture({ animations: [brief] }));
		expect(findings.map((one) => one.rule)).toEqual([
			"animation-under-reduced-motion",
		]);
		expect(findings[0]?.authority).toBe("best-practice");
	});

	it("leaves a brief transition alone", () => {
		// The preference asks for less motion, not none: a fade this
		// short is how a page avoids a jarring pop.
		const fade = animation({
			name: "opacity",
			kind: "CSSTransition",
			durationMs: BRIEF_MS,
			iterations: "1",
		});
		expect(rules(capture({ animations: [fade] }))).toEqual([]);
	});

	it("ignores an animation that is paused", () => {
		const paused = animation({ playState: "paused" });
		expect(rules(capture({ animations: [paused] }))).toEqual([]);
	});

	it("calls out scroll-driven animation under 2.3.3", () => {
		const ride = animation({ scroll: true, iterations: "1", durationMs: 1 });
		const findings = analyseMotion(capture({ animations: [ride] }));
		expect(findings.map((one) => one.rule)).toEqual([
			"scroll-animation-under-reduced-motion",
		]);
		expect(findings[0]?.criteria).toContain("2.3.3");
		expect(findings[0]?.levels).toContain("AAA");
	});

	it("treats an animation with no known end as endless", () => {
		// No duration reported means the total cannot be known, and
		// unknowable is judged as the worse of the two readings.
		const unknown = animation({
			durationMs: undefined,
			iterations: "1",
		});
		expect(rules(capture({ animations: [unknown] }))).toEqual([
			"animation-runs-under-reduced-motion",
		]);
	});

	it("keeps the boundary itself inside the advice band", () => {
		const edge = animation({
			durationMs: PAUSE_STOP_HIDE_MS,
			iterations: "1",
		});
		expect(rules(capture({ animations: [edge] }))).toEqual([
			"animation-under-reduced-motion",
		]);
	});
});
