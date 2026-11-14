/**
 * The journal's line for an error a headless conversation's extension
 * threw: the extension and its event, then the extension's own stack when
 * pi kept one, and its message when not.
 */
import { describe, expect, it } from "vitest";
import { extensionErrorLine } from "../../../host/engine/headless.ts";

describe("extensionErrorLine", () => {
	it("names the extension and its event, then its own stack", () => {
		expect(
			extensionErrorLine({
				extensionPath: "/x/quest-workflow/index.ts",
				event: "session_start",
				error: "boom",
				stack: "Error: boom\n    at start (/x/quest-workflow/index.ts:4:9)",
			}),
		).toBe(
			"Extension error (/x/quest-workflow/index.ts, session_start): Error: boom\n    at start (/x/quest-workflow/index.ts:4:9)",
		);
	});

	it("says the message when pi kept no stack", () => {
		expect(
			extensionErrorLine({
				extensionPath: "/x/park-workflow/index.ts",
				event: "turn_end",
				error: "the record is gone",
			}),
		).toBe(
			"Extension error (/x/park-workflow/index.ts, turn_end): the record is gone",
		);
	});
});
