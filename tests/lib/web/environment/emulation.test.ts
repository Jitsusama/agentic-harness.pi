/**
 * Emulation intent. The behaviour that matters most is the one
 * measured against Chrome: media emulation replaces rather than
 * merges, so anything less than the full feature set silently
 * undoes an earlier setting.
 */

import { describe, expect, it } from "vitest";
import {
	divergences,
	type EmulationState,
	mediaFeaturesOf,
	mergeEmulation,
	type ObservedEnvironment,
} from "../../../../lib/web/environment/emulation.js";

const observed = (
	over: Partial<ObservedEnvironment> = {},
): ObservedEnvironment => ({
	colorScheme: "light",
	reducedMotion: false,
	contrast: "no-preference",
	forcedColors: false,
	print: false,
	width: 800,
	height: 600,
	devicePixelRatio: 1,
	maxTouchPoints: 0,
	touchEvents: false,
	language: "en-US",
	timezone: "America/Toronto",
	...over,
});

describe("mergeEmulation", () => {
	it("leaves untouched what the change does not mention", () => {
		const merged = mergeEmulation(
			{ colorScheme: "dark", reducedMotion: true },
			{ forcedColors: true },
		);
		expect(merged).toEqual({
			colorScheme: "dark",
			reducedMotion: true,
			forcedColors: true,
		});
	});

	it("replaces a value the change does mention", () => {
		expect(
			mergeEmulation({ colorScheme: "dark" }, { colorScheme: "light" }),
		).toEqual({ colorScheme: "light" });
	});

	it("treats undefined as indifference, not as a request to clear", () => {
		expect(
			mergeEmulation({ reducedMotion: true }, { reducedMotion: undefined }),
		).toEqual({ reducedMotion: true });
	});

	it("clears through the neutral value, which is expressible", () => {
		expect(
			mergeEmulation({ reducedMotion: true }, { reducedMotion: false }),
		).toEqual({ reducedMotion: false });
	});
});

describe("mediaFeaturesOf", () => {
	it("emits every set feature, so one change cannot undo another", () => {
		// Chrome forgets anything a setEmulatedMedia call omits, so
		// a partial list is how reduced motion silently turns off.
		const features = mediaFeaturesOf({
			colorScheme: "dark",
			reducedMotion: true,
			contrast: "more",
			forcedColors: true,
		});
		expect(features).toHaveLength(4);
		expect(features).toContainEqual({
			name: "prefers-reduced-motion",
			value: "reduce",
		});
		expect(features).toContainEqual({
			name: "forced-colors",
			value: "active",
		});
	});

	it("says the neutral value rather than dropping a feature turned off", () => {
		expect(mediaFeaturesOf({ reducedMotion: false })).toEqual([
			{ name: "prefers-reduced-motion", value: "no-preference" },
		]);
	});

	it("emits nothing for an intent that asks for nothing", () => {
		expect(mediaFeaturesOf({})).toEqual([]);
	});
});

describe("divergences", () => {
	it("finds nothing when the page agrees", () => {
		expect(divergences({ colorScheme: "light" }, observed())).toEqual([]);
	});

	it("reports a colour scheme that did not take", () => {
		const [first] = divergences({ colorScheme: "dark" }, observed());
		expect(first?.what).toBe("colour scheme");
		expect(first?.observed).toBe("light");
	});

	it("explains that a locale override never reaches navigator.language", () => {
		const [first] = divergences(
			{ locale: "fr-CA" },
			observed({ language: "en-US" }),
		);
		expect(first?.what).toBe("locale");
		expect(first?.note).toContain("navigator.language");
	});

	it("warns that touch emulation leaves ontouchstart absent", () => {
		const [first] = divergences(
			{ touch: true },
			observed({ maxTouchPoints: 5, touchEvents: false }),
		);
		expect(first?.what).toBe("touch");
		expect(first?.note).toContain("ontouchstart");
	});

	it("explains a viewport width the page did not adopt", () => {
		const asked: EmulationState = {
			viewport: { width: 390, height: 844, mobile: true },
		};
		const [first] = divergences(asked, observed({ width: 980 }));
		expect(first?.what).toBe("viewport width");
		expect(first?.observed).toBe("980px");
		expect(first?.note).toContain("viewport meta tag");
	});

	it("says nothing about settings that were never asked for", () => {
		expect(divergences({}, observed({ language: "fr-CA" }))).toEqual([]);
	});
});
