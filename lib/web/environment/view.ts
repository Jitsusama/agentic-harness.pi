/**
 * Reading the emulated environment back.
 *
 * Led by what the page observes rather than by what was asked
 * for, so a setting that did not take cannot read as though it
 * did.
 */

import type {
	Divergence,
	EmulationState,
	ObservedEnvironment,
} from "./emulation.js";

/** What the page is experiencing, and where that differs from the ask. */
export function renderEnvironment(
	asked: EmulationState,
	observed: ObservedEnvironment,
	gaps: readonly Divergence[],
): string {
	const lines = [
		"The page reports:",
		`  ${observed.width} by ${observed.height} at ${observed.devicePixelRatio}x`,
		`  colour scheme ${observed.colorScheme}` +
			`, contrast ${observed.contrast}` +
			`, reduced motion ${observed.reducedMotion ? "on" : "off"}` +
			`, forced colours ${observed.forcedColors ? "on" : "off"}`,
		`  ${observed.language} in ${observed.timezone}`,
		`  ${
			observed.maxTouchPoints > 0
				? `${observed.maxTouchPoints} touch points`
				: "no touch"
		}${observed.touchEvents ? ", touch events present" : ""}` +
			`${observed.print ? ", print stylesheet active" : ""}`,
	];

	// Vision deficiency is a filter over what is painted, so no
	// media query reports it and the page cannot be asked. It is
	// the one thing here that has to be taken on our own word.
	if (asked.vision !== undefined && asked.vision !== "none") {
		lines.push(
			`  simulating ${asked.vision}, which paints differently but is ` +
				"invisible to the page's own scripts",
		);
	}
	if (asked.cpuThrottle !== undefined && asked.cpuThrottle > 1) {
		lines.push(`  cpu slowed ${asked.cpuThrottle} times`);
	}

	if (gaps.length > 0) {
		lines.push("", "Asked for, but not what the page sees:");
		for (const gap of gaps) {
			lines.push(`  ${gap.what}: asked ${gap.asked}, got ${gap.observed}`);
			if (gap.note) lines.push(`    ${gap.note}`);
		}
	}

	return lines.join("\n");
}
