/**
 * Pretending to be a different visitor.
 *
 * Two measured facts shape everything here. Chrome's media
 * emulation is a replacement, not a merge: sending one feature
 * silently clears every other, so the session keeps the whole
 * intent and re-sends all of it each time. And several
 * overrides only partly land, notably locale, which changes
 * how dates format without ever reaching navigator.language.
 * So nothing here reports what it asked for; it reports what
 * the page turned out to observe, and says where the two
 * disagree.
 */

/** Sight conditions Chrome can simulate. */
export type VisionDeficiency =
	| "none"
	| "achromatopsia"
	| "blurredVision"
	| "deuteranopia"
	| "protanopia"
	| "tritanopia"
	| "reducedContrast";

/** What we have asked the browser to pretend. */
export interface EmulationState {
	readonly colorScheme?: "light" | "dark";
	readonly reducedMotion?: boolean;
	readonly contrast?: "more" | "less" | "no-preference";
	readonly forcedColors?: boolean;
	readonly media?: "screen" | "print";
	readonly vision?: VisionDeficiency;
	readonly device?: string;
	readonly viewport?: {
		readonly width: number;
		readonly height: number;
		readonly deviceScaleFactor?: number;
		readonly mobile?: boolean;
	};
	readonly touch?: boolean;
	readonly timezone?: string;
	readonly locale?: string;
	readonly cpuThrottle?: number;
	readonly geolocation?: {
		readonly latitude: number;
		readonly longitude: number;
		readonly accuracy?: number;
	};
}

/** What the page says it is actually experiencing. */
export interface ObservedEnvironment {
	readonly colorScheme: string;
	readonly reducedMotion: boolean;
	readonly contrast: string;
	readonly forcedColors: boolean;
	readonly print: boolean;
	readonly width: number;
	readonly height: number;
	readonly devicePixelRatio: number;
	readonly maxTouchPoints: number;
	readonly touchEvents: boolean;
	readonly language: string;
	readonly timezone: string;
}

/** One media feature as the protocol wants it. */
export interface MediaFeature {
	readonly name: string;
	readonly value: string;
}

/**
 * Fold a change into the standing intent.
 *
 * Undefined means "leave as it was", so a caller can turn on
 * reduced motion without having to restate the colour scheme.
 * Clearing is done by asking for the neutral value, not by
 * omitting the key, because omission cannot be told from
 * indifference.
 */
export function mergeEmulation(
	current: EmulationState,
	change: EmulationState,
): EmulationState {
	const merged: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(change)) {
		if (value !== undefined) merged[key] = value;
	}
	return merged as EmulationState;
}

/**
 * Every media feature the intent implies, always in full.
 *
 * Chrome treats each setEmulatedMedia call as the complete
 * truth and forgets anything not mentioned, measured directly:
 * setting prefers-contrast alone cleared a
 * prefers-reduced-motion set moments earlier. Sending the whole
 * set every time is what stops one change from undoing
 * another.
 */
export function mediaFeaturesOf(
	state: EmulationState,
): readonly MediaFeature[] {
	const features: MediaFeature[] = [];
	if (state.colorScheme !== undefined) {
		features.push({ name: "prefers-color-scheme", value: state.colorScheme });
	}
	if (state.reducedMotion !== undefined) {
		features.push({
			name: "prefers-reduced-motion",
			value: state.reducedMotion ? "reduce" : "no-preference",
		});
	}
	if (state.contrast !== undefined) {
		features.push({ name: "prefers-contrast", value: state.contrast });
	}
	if (state.forcedColors !== undefined) {
		features.push({
			name: "forced-colors",
			value: state.forcedColors ? "active" : "none",
		});
	}
	return features;
}

/** One place where the page disagrees with what was asked. */
export interface Divergence {
	readonly what: string;
	readonly asked: string;
	readonly observed: string;
	readonly note?: string;
}

/**
 * Where what was asked for and what the page sees disagree.
 *
 * Not every override lands completely, and a report that
 * repeated the request back would hide exactly the cases worth
 * knowing about.
 */
export function divergences(
	asked: EmulationState,
	observed: ObservedEnvironment,
): readonly Divergence[] {
	const found: Divergence[] = [];

	if (
		asked.colorScheme !== undefined &&
		observed.colorScheme !== asked.colorScheme
	) {
		found.push({
			what: "colour scheme",
			asked: asked.colorScheme,
			observed: observed.colorScheme,
		});
	}
	if (
		asked.reducedMotion !== undefined &&
		observed.reducedMotion !== asked.reducedMotion
	) {
		found.push({
			what: "reduced motion",
			asked: String(asked.reducedMotion),
			observed: String(observed.reducedMotion),
		});
	}
	if (
		asked.forcedColors !== undefined &&
		observed.forcedColors !== asked.forcedColors
	) {
		found.push({
			what: "forced colours",
			asked: String(asked.forcedColors),
			observed: String(observed.forcedColors),
		});
	}
	if (asked.locale !== undefined && observed.language !== asked.locale) {
		found.push({
			what: "locale",
			asked: asked.locale,
			observed: observed.language,
			note:
				"the override reaches date and number formatting but not " +
				"navigator.language, which scripts read",
		});
	}
	if (asked.timezone !== undefined && observed.timezone !== asked.timezone) {
		found.push({
			what: "timezone",
			asked: asked.timezone,
			observed: observed.timezone,
		});
	}
	if (asked.touch === true && !observed.touchEvents) {
		found.push({
			what: "touch",
			asked: "touch events available",
			observed: `maxTouchPoints ${observed.maxTouchPoints}, ontouchstart absent`,
			note:
				"a script sniffing for ontouchstart will still decide this " +
				"is not a touch device",
		});
	}
	if (asked.viewport !== undefined && observed.width !== asked.viewport.width) {
		found.push({
			what: "viewport width",
			asked: `${asked.viewport.width}px`,
			observed: `${observed.width}px`,
			note:
				"a page with no viewport meta tag is laid out at the " +
				"desktop default regardless of the device",
		});
	}

	return found;
}
