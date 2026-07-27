/**
 * What a session pretends to be, and how the pretence is kept.
 *
 * The intent is held whole and re-applied in full, because
 * Chrome's media emulation forgets anything a call omits, and a
 * cross-process navigation swaps the renderer the flags live in.
 * Applying, observing and diverging all live here so the one
 * piece of state has one keeper.
 */

import { KnownDevices } from "puppeteer-core";
import { deviceEmulation, noSuchDevice } from "../environment/devices.js";
import {
	type Divergence,
	divergences,
	type EmulationState,
	ENVIRONMENT_PROBE,
	mediaFeaturesOf,
	mergeEmulation,
	type ObservedEnvironment,
	unsupportedFields,
} from "../environment/index.js";
import type { SessionWires } from "./wires.js";

/**
 * Touch points a touch device is given, matching a common phone.
 *
 * Layered over the driver's own request, which asks only for touch
 * to exist. If a navigation ever costs us this command again, the
 * driver restores touch with one point rather than none, so the
 * page stays a touch device and only the count degrades.
 */
const TOUCH_POINTS = 5;

/** Metres of accuracy claimed for an overridden position. */
const GEOLOCATION_ACCURACY = 10;

/** What emulation needs from the session besides the browser. */
interface EmulationHooks {
	/** Wait for the reflow an emulation change starts to finish. */
	readonly settle: () => Promise<unknown>;
}

/** The standing pretence, applied, observed and diverged. */
export class EmulationController {
	/** What this session is pretending to be. */
	private state: EmulationState = {};

	constructor(
		private readonly wires: SessionWires,
		private readonly hooks: EmulationHooks,
	) {}

	/** What this session has asked the browser to pretend. */
	get asked(): EmulationState {
		return this.state;
	}

	/** Whether the page believes it is being touched. */
	get touch(): boolean {
		return this.state.touch === true;
	}

	/**
	 * Put the emulation back exactly as it was.
	 *
	 * change merges, which is right for a caller adding one
	 * condition and wrong for anything that has to undo itself: a
	 * merge cannot clear a field, so a sweep that widened the
	 * viewport could never restore a session that had none. This
	 * replaces the state wholesale.
	 */
	async restore(state: EmulationState): Promise<void> {
		await this.wires.ready();
		this.state = state;
		await this.apply();
	}

	/**
	 * Pretend to be a different visitor, then report what the page
	 * actually experiences.
	 *
	 * The intent is kept whole and re-applied in full, because
	 * Chrome's media emulation forgets anything a call omits, so
	 * asking for reduced motion after asking for dark mode would
	 * otherwise turn the dark mode back off.
	 */
	async change(
		change: EmulationState = {},
		/** Overrides to take off, which an absent key cannot express. */
		clear: readonly (keyof EmulationState)[] = [],
	): Promise<{
		asked: EmulationState;
		observed: ObservedEnvironment;
		gaps: readonly Divergence[];
	}> {
		await this.wires.ready();
		// Anything this cannot emulate is named before it is dropped.
		// Silently ignoring a field meant a call asking for a 1024px
		// viewport did nothing, said nothing, and reported no gaps.
		const ignored = unsupportedFields(
			change as Readonly<Record<string, unknown>>,
		);
		this.state = mergeEmulation(this.state, change, clear);
		// A device this catalogue has never heard of is reported the
		// same way as a field with nothing behind it, rather than
		// echoed back as though it had been honoured.
		const device = this.state.device;
		const unknown =
			device !== undefined && !deviceEmulation(device, KnownDevices)
				? [
						{
							what: "device",
							asked: device,
							observed: "ignored, no device by that name",
							note: noSuchDevice(device, KnownDevices),
						},
					]
				: [];
		await this.apply();
		// A viewport change reflows the page and a real application
		// re-renders for it, so the same wait a navigation gets applies
		// here: without it the next read describes the old layout.
		await this.hooks.settle();
		const observed = await this.observe();
		// Emulating before navigating is the order this tool asks for,
		// and it used to be punished for it. There is nothing laid out
		// on a blank page, so the width comes back as the desktop
		// default and ontouchstart has no document to be installed on:
		// two alarming gaps that both come right the moment a real page
		// loads. Reporting them as divergences sent me measuring the
		// wrong thing twice. What the page cannot answer yet is not a
		// discrepancy, so it is held back and said plainly instead.
		const blank = this.wires.page().url() === "about:blank";
		const measured = blank
			? [
					{
						what: "the page",
						asked: "nothing loaded yet",
						observed: "about:blank",
						note:
							"layout and touch cannot be checked until a document " +
							"is loaded; navigate, then read status to confirm",
					},
				]
			: divergences(this.effective, observed);
		return {
			asked: this.state,
			observed,
			// Compared against the effective state, since a device is
			// the reason a viewport is what it is.
			gaps: [...ignored, ...unknown, ...measured],
		};
	}

	/**
	 * Put the standing intent to the browser again, after arriving.
	 *
	 * Kept, though the driver now carries emulation across a
	 * navigation itself, because this same path restores a session
	 * after a crash and because it costs nothing when nothing is
	 * being emulated.
	 *
	 * What is gone is what used to sit under here: a second
	 * application on the document-arrival event, and a loop that
	 * asked the page whether the first two had worked. Both were
	 * workarounds for sending emulation on a protocol session of our
	 * own, and neither made it certain. Removing the cause removed
	 * the need for either, measured twelve times out of twelve
	 * through the shape that used to fail one time in three.
	 */
	async reassert(): Promise<void> {
		if (Object.keys(this.state).length === 0) return;
		await this.apply();
	}

	/**
	 * How the pretence and the page disagree right now.
	 *
	 * Checked rather than recited. What is being emulated is what
	 * the session asked for, and a navigation can quietly drop part
	 * of it, so the page is asked whether it agrees before status
	 * says it is pretending to be a phone. A blank page has nothing
	 * laid out to check, so it reports no gaps rather than fake ones.
	 */
	async currentGaps(): Promise<readonly Divergence[]> {
		const blank = this.wires.page().url() === "about:blank";
		if (blank || Object.keys(this.state).length === 0) return [];
		return divergences(this.effective, await this.observe());
	}

	/**
	 * The standing intent with any named device resolved.
	 *
	 * A device is shorthand for a viewport and a touch screen, and
	 * anything the caller said explicitly outranks it: asking for a
	 * phone and a width means the phone with that width.
	 */
	private get effective(): EmulationState {
		const asked = this.state;
		if (asked.device === undefined) return asked;
		const fromDevice = deviceEmulation(asked.device, KnownDevices);
		if (!fromDevice) return asked;
		return { ...fromDevice, ...asked };
	}

	/** Put the whole standing intent to the browser. */
	async apply(): Promise<void> {
		const state = this.effective;
		const page = this.wires.page();

		// Every one of these goes through the driver rather than the
		// protocol, and that is the whole fix for emulation not
		// surviving a navigation.
		//
		// A cross-process navigation swaps the target's protocol
		// session. The driver listens for that swap and puts its whole
		// emulation state to the new session; commands sent on a session
		// of our own just went to the renderer being replaced. Device
		// metrics are held browser-side and came through regardless,
		// which is why this looked like a touch-only fault: touch is a
		// flag in the renderer, so the page quietly stopped being a
		// phone while the report still said it was one.
		await page.emulateMediaType(state.media);
		await page.emulateMediaFeatures([...mediaFeaturesOf(state)]);
		await page.emulateVisionDeficiency(state.vision ?? "none");

		// Screen, touch and user agent go through the driver rather
		// than the protocol, which is the whole reason they now survive
		// a navigation.
		await page.setViewport(
			state.viewport
				? {
						width: state.viewport.width,
						height: state.viewport.height,
						deviceScaleFactor: state.viewport.deviceScaleFactor ?? 1,
						isMobile: state.viewport.mobile ?? false,
						hasTouch: state.touch ?? false,
					}
				: // Null is how the driver spells "stop overriding", and
					// touch has to be asked for separately when there is no
					// viewport to carry it.
					null,
		);
		// The driver asks for a touch screen without saying how many
		// fingers, which Chrome reads as one; a real phone reports five,
		// so that is asked for on top.
		//
		// Sent every time, including to turn it off. Sending it only
		// when touch was wanted left a phone that could not stop being
		// one: this override rides on our own protocol session, the
		// driver's disable rides on its own, and one session cannot
		// clear the other's. So the viewport and the user agent went
		// back to the desktop while the touch screen stayed.
		await this.wires.cdp().send("Emulation.setTouchEmulationEnabled", {
			enabled: state.touch ?? false,
			...(state.touch ? { maxTouchPoints: TOUCH_POINTS } : {}),
		});
		// An empty string is how this one is taken off again.
		await page.setUserAgent(state.userAgent ?? "");
		await page.emulateCPUThrottling(state.cpuThrottle ?? null);

		// Passed undefined rather than skipped, because an override
		// with no arguments is how one gets taken off again. Guarding
		// these on being defined meant nothing could ever be cleared: a
		// session that emulated Tokyo once stayed in Tokyo for its life,
		// quietly recolouring every later reading.
		await page.emulateTimezone(state.timezone);
		await page.emulateLocale(state.locale);
		if (state.geolocation === undefined) {
			await this.wires.cdp().send("Emulation.clearGeolocationOverride");
		} else {
			await this.wires.cdp().send("Emulation.setGeolocationOverride", {
				latitude: state.geolocation.latitude,
				longitude: state.geolocation.longitude,
				accuracy: state.geolocation.accuracy ?? GEOLOCATION_ACCURACY,
			});
		}
	}

	/** What the page says it is experiencing. */
	private async observe(): Promise<ObservedEnvironment> {
		const { result } = await this.wires.cdp().send("Runtime.evaluate", {
			expression: ENVIRONMENT_PROBE,
			returnByValue: true,
		});
		return result.value as ObservedEnvironment;
	}
}
