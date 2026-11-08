/**
 * Refuse to run the browser lane with no Chrome to drive.
 *
 * Every test in the lane drives a real Chrome, and the default lane
 * leaves them all out, so `pnpm test:browser` is only ever run to drive
 * one. Each suite used to skip itself where Chrome was missing, which
 * made a machine without one report the whole lane as passed having
 * tested nothing. This runs once before any worker starts and fails the
 * run with what resolving Chrome said, which names CHROME_PATH.
 */

import { resolveChromePath } from "../../lib/core/web/chrome.ts";

export default function setup(): void {
	try {
		resolveChromePath(process.env.CHROME_PATH);
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		throw new Error(`The browser lane drives a real Chrome. ${why}`);
	}
}
