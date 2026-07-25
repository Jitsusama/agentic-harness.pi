/**
 * What is moving.
 *
 * Motion explains readings that otherwise look wrong: a style
 * caught mid-transition, an element that is not where it will
 * be a moment later. It is also an accessibility question,
 * since something animating without end is a barrier for
 * readers who need the page to hold still.
 */

/** An animation as the page reported it. */
export interface RawAnimation {
	readonly name?: string;
	readonly kind: string;
	readonly playState: string;
	readonly durationMs?: number;
	readonly easing?: string;
	/**
	 * How many times it repeats, as text. An endless animation
	 * counts Infinity, which becomes null once serialized, so the
	 * page sends the word instead.
	 */
	readonly iterations?: string;
}

/** Something moving on an element. */
export interface Animation {
	readonly name: string;
	readonly kind: string;
	readonly playState: string;
	readonly durationMs?: number;
	readonly easing?: string;
	readonly iterations: string;
}

/** Read a capture's animations. */
export function normalizeAnimations(
	raw: readonly RawAnimation[],
): readonly Animation[] {
	return raw.map((animation) => ({
		name: animation.name || "unnamed",
		kind: animation.kind,
		playState: animation.playState,
		...(animation.durationMs === undefined
			? {}
			: { durationMs: animation.durationMs }),
		...(animation.easing === undefined ? {} : { easing: animation.easing }),
		iterations:
			animation.iterations === "Infinity"
				? "endless"
				: (animation.iterations ?? "1"),
	}));
}

/** Say what is moving and how. */
export function renderAnimations(animations: readonly Animation[]): string {
	if (animations.length === 0) return "Nothing is animating.";
	return animations
		.map((animation) => {
			const parts = [animation.name, animation.kind, animation.playState];
			if (animation.durationMs !== undefined) {
				parts.push(`${animation.durationMs}ms`);
			}
			if (animation.easing) parts.push(animation.easing);
			// Repeating once is what everything does; only an
			// unusual count is worth the words.
			if (animation.iterations !== "1") parts.push(animation.iterations);
			return parts.join("  ");
		})
		.join("\n");
}

/**
 * Read what is animating on an element.
 *
 * Runs with the element as its receiver. Iteration counts are
 * stringified in the page because Infinity does not survive
 * being serialized and would arrive as null, reading as though
 * an endless animation had no repeat count at all.
 *
 * Page source rather than a function, for the reason given in
 * the accessibility observer.
 */
export const ANIMATIONS_PROBE = `function () {
  if (!this.getAnimations) return [];
  return this.getAnimations().map(function (animation) {
    var timing = animation.effect && animation.effect.getTiming
      ? animation.effect.getTiming()
      : {};
    var duration = typeof timing.duration === "number"
      ? timing.duration
      : undefined;
    return {
      name: animation.animationName || animation.transitionProperty || "",
      kind: animation.transitionProperty ? "transition" : "animation",
      playState: animation.playState,
      durationMs: duration,
      easing: timing.easing,
      iterations: String(timing.iterations),
    };
  });
}`;
