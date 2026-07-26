/**
 * Turning a device name into something to emulate.
 *
 * The catalogue of devices is Chrome's own, which arrives through
 * puppeteer and so cannot be imported here: this module is on the
 * pure side of the library and must stay loadable without a
 * browser. So the catalogue is a parameter. The caller that has
 * one passes it; the tests pass a small one and can describe
 * devices that do not exist.
 *
 * This lived in the extension, where it worked, and left
 * `EmulationState.device` as a field the library accepted and
 * ignored. A consumer asking the library for an iPhone got no
 * phone, no error and no divergence: the viewport stayed at
 * 800x600 while the report echoed the device name back as though
 * it had been honoured. A field that lies is worse than a field
 * that is missing, and this is meant to be a library other
 * packages build on.
 */

import type { EmulationState } from "./emulation.js";

/**
 * The shape this needs from a device catalogue.
 *
 * Deliberately narrower than what puppeteer's KnownDevices
 * provides, so that the widest possible range of catalogues
 * satisfies it, including one written by hand in a test.
 */
export interface DeviceProfile {
	readonly userAgent?: string;
	readonly viewport: {
		readonly width: number;
		readonly height: number;
		readonly deviceScaleFactor?: number;
		readonly isMobile?: boolean;
		readonly hasTouch?: boolean;
	};
}

/** A set of device profiles by name, as Chrome ships them. */
export type DeviceCatalogue = Readonly<Record<string, DeviceProfile>>;

/** How many near matches are worth offering. */
const MAX_SUGGESTIONS = 5;

/**
 * What emulating a named device means, or undefined if unknown.
 *
 * Only the fields the device itself determines are returned, so a
 * caller can layer it under an explicit request and let the
 * explicit one win.
 */
export function deviceEmulation(
	name: string,
	catalogue: DeviceCatalogue,
): EmulationState | undefined {
	const profile = catalogue[name];
	if (!profile) return undefined;
	return {
		device: name,
		viewport: {
			width: profile.viewport.width,
			height: profile.viewport.height,
			deviceScaleFactor: profile.viewport.deviceScaleFactor ?? 1,
			mobile: profile.viewport.isMobile ?? false,
		},
		touch: profile.viewport.hasTouch ?? false,
		// Half of what makes a site serve its phone layout is the
		// string it is asked in. Emulating the screen and not the
		// user agent meant a phone that every server still took for
		// a desktop, so the page under test was often not the page a
		// phone would get.
		...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
	};
}

/**
 * Device names close enough to what was asked for to be worth
 * offering back.
 *
 * A wrong model number is the likeliest way to miss, so a failed
 * match on the whole string falls back to the family name: asking
 * for an "iPhone 99" should still hear about the iPhones rather
 * than nothing at all.
 */
export function nearestDevices(
	name: string,
	catalogue: DeviceCatalogue,
): readonly string[] {
	const asked = name.toLowerCase();
	const names = Object.keys(catalogue);
	const holds = (needle: string): string[] =>
		names.filter((candidate) => candidate.toLowerCase().includes(needle));
	const direct = holds(asked);
	if (direct.length > 0) return direct.slice(0, MAX_SUGGESTIONS);
	const family = asked.split(" ")[0] ?? asked;
	return holds(family).slice(0, MAX_SUGGESTIONS);
}

/**
 * Say that a device could not be found, and what was nearby.
 *
 * Written once here because both the tool, which refuses before
 * doing anything, and the library, which reports it as a
 * divergence, have to say the same thing.
 */
export function noSuchDevice(name: string, catalogue: DeviceCatalogue): string {
	const near = nearestDevices(name, catalogue);
	return (
		`No device named '${name}'.` +
		(near.length > 0
			? ` Did you mean ${near.join(", ")}?`
			: " Chrome ships names like 'iPhone 15 Pro' and 'Pixel 5'.")
	);
}
