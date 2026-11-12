/**
 * What a parked window is left showing once its pi has gone.
 */

import { describe, expect, it } from "vitest";
import { hideResumeHint } from "../../../extensions/park-workflow/watch.ts";

// KP0L6A, 11 November: a parked window ended with three lines saying the
// same thing, pushing Joel's last screen up.
describe("what a parked window is left showing", () => {
	it("leaves out pi's resume hint, which pi prints only to a terminal", () => {
		const was = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		try {
			Object.defineProperty(process.stdout, "isTTY", {
				value: true,
				configurable: true,
			});
			hideResumeHint();
			expect(process.stdout.isTTY, "pi reads no terminal to hint at").toBe(
				false,
			);
		} finally {
			if (was) Object.defineProperty(process.stdout, "isTTY", was);
			else Reflect.deleteProperty(process.stdout, "isTTY");
		}
	});
});
