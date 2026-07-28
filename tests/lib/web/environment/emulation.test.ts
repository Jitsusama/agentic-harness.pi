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
	refusedFeature,
	unsupportedFields,
	withoutFeature,
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

describe("a request that cannot be honoured says so", () => {
	// Asking for a flat width is the natural mistake, since that is
	// how the tool's own surface spells it. Accepted in silence, it
	// left the page at its old size while reporting no gaps, and I
	// spent twenty minutes measuring the wrong viewport and
	// concluding a page was fine.
	it("names a field it cannot emulate", () => {
		const [gap] = unsupportedFields({ width: 1024 });
		expect(gap?.what).toBe("width");
		expect(gap?.observed).toContain("ignored");
	});

	it("points at the field that carries it", () => {
		expect(unsupportedFields({ width: 1024 })[0]?.note).toContain("viewport");
		expect(unsupportedFields({ language: "fr" })[0]?.note).toContain("locale");
	});

	it("says nothing about a request it understands", () => {
		expect(
			unsupportedFields({
				viewport: { width: 1024, height: 800 },
				colorScheme: "dark",
				vision: "protanopia",
			}),
		).toEqual([]);
	});

	it("ignores a field explicitly set to undefined", () => {
		// Clearing an override is how the protocol is told to stop, so
		// an undefined value is a request rather than a mistake.
		expect(unsupportedFields({ nonsense: undefined })).toEqual([]);
	});

	it("reports every invented field, not just the first", () => {
		expect(unsupportedFields({ width: 1, height: 2 })).toHaveLength(2);
	});
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

describe("taking an override off again", () => {
	// Skipping undefined is what lets one field be mentioned without
	// disturbing the rest, and it is also why an absent key cannot
	// mean "stop". Without a way to say so, a session that emulated
	// Tokyo once stayed in Tokyo for the rest of its life, and
	// nothing could stop pretending to be a phone.
	it("cannot be said by passing nothing", () => {
		const merged = mergeEmulation(
			{ timezone: "Asia/Tokyo" },
			{ timezone: undefined },
		);
		expect(merged.timezone).toBe("Asia/Tokyo");
	});

	it("is said by naming the field", () => {
		const merged = mergeEmulation({ timezone: "Asia/Tokyo" }, {}, ["timezone"]);
		expect(merged.timezone).toBeUndefined();
	});

	it("leaves everything it was not asked about", () => {
		const merged = mergeEmulation(
			{ timezone: "Asia/Tokyo", colorScheme: "dark" },
			{},
			["timezone"],
		);
		expect(merged.colorScheme).toBe("dark");
	});

	it("lets the same call clear one field and set another", () => {
		const merged = mergeEmulation({ device: "Pixel 5" }, { media: "print" }, [
			"device",
		]);
		expect(merged.device).toBeUndefined();
		expect(merged.media).toBe("print");
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

	it("warns when the page counts no touch points at all", () => {
		// Touch can be applied by halves: the event handler is on the
		// window and the count is still zero. Only the handler was
		// checked, so the tool reported an untroubled phone while a
		// script asking navigator.maxTouchPoints, which is the modern
		// way to ask and the one feature detection guides recommend,
		// decided there was no touch screen. Someone reading that
		// concludes the site is broken on mobile when the emulation is
		// what is broken.
		const found = divergences(
			{ touch: true },
			observed({ maxTouchPoints: 0, touchEvents: true }),
		);

		expect(found.map((gap) => gap.what)).toContain("touch");
	});

	it("is quiet when touch arrived by both signals", () => {
		const found = divergences(
			{ touch: true },
			observed({ maxTouchPoints: 5, touchEvents: true }),
		);

		expect(found.map((gap) => gap.what)).not.toContain("touch");
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

describe("refusedFeature", () => {
	it("names the feature Chrome would not emulate", () => {
		// Verbatim from a real session: this is the whole message.
		expect(refusedFeature("Unsupported media feature: forced-colors")).toBe(
			"forced-colors",
		);
		expect(refusedFeature("Unsupported media feature: prefers-contrast")).toBe(
			"prefers-contrast",
		);
	});

	it("stays quiet about a failure that is not a refused feature", () => {
		// Dropping state on any error at all would quietly discard an
		// intent that a disconnect, not the feature, defeated.
		expect(refusedFeature("Target closed")).toBeUndefined();
		expect(refusedFeature("")).toBeUndefined();
	});
});

describe("withoutFeature", () => {
	it("drops the refused feature and keeps every other intent", () => {
		// The whole set goes to Chrome together, so one refusal takes the
		// working features with it unless the refused one is dropped.
		const asked: EmulationState = {
			colorScheme: "dark",
			reducedMotion: true,
			forcedColors: true,
		};

		const left = withoutFeature(asked, "forced-colors");

		expect(left.forcedColors).toBeUndefined();
		expect(left.colorScheme).toBe("dark");
		expect(left.reducedMotion).toBe(true);
		// And the survivor is what would now go to the browser.
		expect(mediaFeaturesOf(left).map((f) => f.name)).not.toContain(
			"forced-colors",
		);
	});

	it("maps every media feature it sends back to the field that set it", () => {
		// A feature this cannot map would be dropped from the report and
		// kept in the state, which is the sticky refusal all over again.
		const asked: EmulationState = {
			colorScheme: "dark",
			reducedMotion: true,
			contrast: "more",
			forcedColors: true,
		};
		for (const { name } of mediaFeaturesOf(asked)) {
			const left = withoutFeature(asked, name);
			expect(mediaFeaturesOf(left).map((f) => f.name)).not.toContain(name);
		}
	});

	it("leaves the intent alone when the name means nothing to it", () => {
		const asked: EmulationState = { colorScheme: "dark" };
		expect(withoutFeature(asked, "prefers-reduced-transparency")).toEqual(
			asked,
		);
	});
});
