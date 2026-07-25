/**
 * How an element looks in states a person has to reach for.
 *
 * Hover, focus and active styles are invisible to a static
 * reading, and they are where accessibility problems hide: a
 * focus ring that never appears, a hover state that is the only
 * cue a thing is interactive. The browser can be told to hold a
 * state, which is the only way to read one without a mouse.
 */

import type { StyleEntry, StyleGroup } from "../styles/index.js";

/** A state the browser can be asked to hold. */
export type PseudoState = "hover" | "focus" | "active" | "focus-visible";

/** What changed about an element while a state was held. */
export interface PseudoVariant {
	readonly state: PseudoState;
	readonly changes: readonly StyleChange[];
}

/** One property that differs between two readings. */
export interface StyleChange {
	readonly property: string;
	readonly from: string;
	readonly to: string;
}

/** Flatten grouped styles into one lookup. */
function flatten(groups: readonly StyleGroup[]): ReadonlyMap<string, string> {
	const flat = new Map<string, string>();
	for (const group of groups) {
		for (const entry of group.entries) flat.set(entry.property, entry.value);
	}
	return flat;
}

/**
 * What a state changed.
 *
 * Only differences are reported. Repeating everything that
 * stayed the same would bury the two lines that answer whether
 * the state is visible at all.
 */
export function diffStyles(
	atRest: readonly StyleGroup[],
	held: readonly StyleGroup[],
): readonly StyleChange[] {
	const before = flatten(atRest);
	const after = flatten(held);
	const changes: StyleChange[] = [];

	for (const [property, to] of after) {
		const from = before.get(property);
		if (from !== to) {
			changes.push({ property, from: from ?? "not set", to });
		}
	}
	// A property present at rest and gone while held changed too,
	// and it is the shape a disappearing outline takes.
	for (const [property, from] of before) {
		if (!after.has(property)) {
			changes.push({ property, from, to: "not set" });
		}
	}
	return changes;
}

/** Say what each held state changed. */
export function renderVariants(variants: readonly PseudoVariant[]): string {
	if (variants.length === 0) return "";
	return variants
		.map((variant) => {
			if (variant.changes.length === 0) {
				return `${variant.state}: nothing changes`;
			}
			return [
				`${variant.state}:`,
				...variant.changes.map(
					(change) => `  ${change.property}: ${change.from} -> ${change.to}`,
				),
			].join("\n");
		})
		.join("\n");
}

/** An entry list as a group, for callers holding a flat read. */
export function asGroup(
	name: string,
	entries: readonly StyleEntry[],
): StyleGroup {
	return { name, entries };
}

/**
 * Wait until the element has stopped moving.
 *
 * Forcing a state starts whatever transition the page declared,
 * and reading the styles immediately catches them at their
 * resting values, which reports that nothing changed. Rather
 * than guessing a delay from the declared durations, this waits
 * on the browser's own promise that each animation has
 * finished. Endless animations are skipped, since waiting for
 * one would never return, and a cap keeps a page that keeps
 * starting new work from holding the read open.
 *
 * Runs with the element as its receiver, and resolves rather
 * than rejecting so a caller always gets its reading.
 */
export const SETTLE_PROBE = `function (capMs) {
  if (!this.getAnimations) return Promise.resolve(false);
  var running = this.getAnimations().filter(function (animation) {
    var timing = animation.effect && animation.effect.getTiming
      ? animation.effect.getTiming()
      : {};
    return Number.isFinite(timing.iterations);
  });
  if (running.length === 0) return Promise.resolve(true);
  var settled = Promise.all(running.map(function (animation) {
    return animation.finished.catch(function () { return null; });
  }));
  var capped = new Promise(function (resolve) {
    setTimeout(function () { resolve(false); }, capMs);
  });
  return Promise.race([settled.then(function () { return true; }), capped]);
}`;
