/**
 * A device name has to mean something to the library, not just to
 * the tool that happened to know how to translate it.
 */

import { describe, expect, it } from "vitest";
import {
	type DeviceCatalogue,
	deviceEmulation,
	nearestDevices,
	noSuchDevice,
} from "../../../../lib/web/environment/devices.js";

// Small enough to reason about, shaped like the real catalogue.
const catalogue: DeviceCatalogue = {
	"iPhone 15 Pro": {
		viewport: {
			width: 393,
			height: 659,
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
		},
	},
	"iPhone SE": {
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
		viewport: { width: 375, height: 667, isMobile: true, hasTouch: true },
	},
	"Pixel 5": {
		viewport: {
			width: 393,
			height: 727,
			deviceScaleFactor: 2.75,
			isMobile: true,
			hasTouch: true,
		},
	},
	"Nexus 10 landscape": { viewport: { width: 1280, height: 800 } },
};

describe("what a device name means", () => {
	it("carries the viewport and the touch screen", () => {
		const asked = deviceEmulation("iPhone 15 Pro", catalogue);
		expect(asked?.viewport).toEqual({
			width: 393,
			height: 659,
			deviceScaleFactor: 3,
			mobile: true,
		});
		expect(asked?.touch).toBe(true);
	});

	it("keeps the name, so a report can say what is being pretended", () => {
		expect(deviceEmulation("Pixel 5", catalogue)?.device).toBe("Pixel 5");
	});

	it("fills in what a profile leaves out", () => {
		// A catalogue entry need not state every field, and a missing
		// scale factor is one rather than zero.
		const asked = deviceEmulation("iPhone SE", catalogue);
		expect(asked?.viewport?.deviceScaleFactor).toBe(1);
	});

	it("says a desktop profile is neither mobile nor touch", () => {
		const asked = deviceEmulation("Nexus 10 landscape", catalogue);
		expect(asked?.viewport?.mobile).toBe(false);
		expect(asked?.touch).toBe(false);
	});

	it("carries the user agent, since a server decides on that", () => {
		// Emulating the screen and not the string meant a phone every
		// server still took for a desktop, so the page under test was
		// often not the page a phone would be served.
		expect(deviceEmulation("iPhone SE", catalogue)?.userAgent).toContain(
			"iPhone",
		);
	});

	it("says nothing about a user agent a profile does not give", () => {
		expect(deviceEmulation("Pixel 5", catalogue)?.userAgent).toBeUndefined();
	});

	it("knows nothing about a device it has never heard of", () => {
		expect(deviceEmulation("Nokia 3310", catalogue)).toBeUndefined();
	});
});

describe("what to offer when the name misses", () => {
	it("offers the models of a family when the model is wrong", () => {
		// A wrong model number is the likeliest way to miss, and
		// hearing nothing back is the least useful answer.
		expect(nearestDevices("iPhone 99", catalogue)).toEqual([
			"iPhone 15 Pro",
			"iPhone SE",
		]);
	});

	it("matches on part of a name", () => {
		expect(nearestDevices("pixel", catalogue)).toEqual(["Pixel 5"]);
	});

	it("offers nothing for a name with no family in common", () => {
		expect(nearestDevices("Nokia 3310", catalogue)).toEqual([]);
	});

	it("names the device that was not found, and what was near", () => {
		const said = noSuchDevice("iPhone 99", catalogue);
		expect(said).toContain("iPhone 99");
		expect(said).toContain("iPhone 15 Pro");
	});

	it("suggests the shape of a name when it can suggest no name", () => {
		expect(noSuchDevice("Nokia 3310", catalogue)).toContain("iPhone 15 Pro");
	});
});
