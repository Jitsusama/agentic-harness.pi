/**
 * Dialog policy. A dialog stops the page until it is answered,
 * which is why there is a default at all: the cautious answer
 * still has to be an answer.
 */

import { describe, expect, it } from "vitest";
import {
	answerFor,
	DEFAULT_DIALOG_POLICY,
	renderDialogs,
} from "../../../../lib/web/telemetry/dialogs.js";

describe("DEFAULT_DIALOG_POLICY", () => {
	it("dismisses, so a confirm guarding a deletion gets a no", () => {
		expect(DEFAULT_DIALOG_POLICY.accept).toBe(false);
	});
});

describe("answerFor", () => {
	it("passes prompt text only to a prompt", () => {
		const policy = { accept: true, promptText: "typed" };
		expect(answerFor("prompt", policy)).toEqual({
			accept: true,
			promptText: "typed",
		});
		expect(answerFor("confirm", policy)).toEqual({ accept: true });
		expect(answerFor("alert", policy)).toEqual({ accept: true });
	});

	it("sends no text when dismissing, since nothing is being typed", () => {
		expect(answerFor("prompt", { accept: false, promptText: "typed" })).toEqual(
			{ accept: false },
		);
	});

	it("leaves the default prompt alone when no text was chosen", () => {
		expect(answerFor("prompt", { accept: true })).toEqual({ accept: true });
	});
});

describe("renderDialogs", () => {
	it("says none rather than printing an empty list", () => {
		expect(renderDialogs([])).toBe("The page has not opened a dialog.");
	});

	it("reports what was asked and how it was answered", () => {
		const out = renderDialogs([
			{ kind: "confirm", message: "are you sure?", accepted: false },
		]);
		expect(out).toContain("confirm: are you sure?");
		expect(out).toContain("dismissed");
	});

	it("shows what was typed into a prompt", () => {
		const out = renderDialogs([
			{
				kind: "prompt",
				message: "your name?",
				accepted: true,
				reply: "typed in",
			},
		]);
		expect(out).toContain("accepted");
		expect(out).toContain('"typed in"');
	});
});
