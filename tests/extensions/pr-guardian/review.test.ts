import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { PrCommand } from "../../../extensions/pr-guardian/parse.js";
import { createPrGuardian } from "../../../extensions/pr-guardian/review.js";

/** A fake pi/ctx pair with no UI and an empty signature store. */
function noUiContext(): { pi: ExtensionAPI; ctx: ExtensionContext } {
	const pi = { appendEntry: () => {} } as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	return { pi, ctx };
}

function prCommand(body: string, title = "A Descriptive Title"): PrCommand {
	return {
		action: "create",
		title,
		body,
		prefix: null,
		prPart: "",
		prNumber: null,
		extraFlags: [],
		suffix: null,
		openerRest: null,
	};
}

const cleanBody = [
	"### 🌐 Situation",
	"The thing was broken.",
	"",
	"### 🔧 Resolution",
	"We fixed it.",
	"",
	"### 🔬 Validation",
	"A test proves it.",
].join("\n");

describe("createPrGuardian review without a UI", () => {
	it("blocks a body with an invented section even with no UI", async () => {
		const { pi, ctx } = noUiContext();
		const result = await createPrGuardian(pi).review(
			prCommand(`${cleanBody}\n\n### Notes\nextra`),
			ctx,
		);
		expect(result && "block" in result).toBe(true);
	});

	it("allows a clean body without invoking the panel", async () => {
		const { pi, ctx } = noUiContext();
		const result = await createPrGuardian(pi).review(prCommand(cleanBody), ctx);
		expect(result).toBeUndefined();
	});

	it("blocks a conventional-commit title even with a clean body", async () => {
		const { pi, ctx } = noUiContext();
		const result = await createPrGuardian(pi).review(
			prCommand(cleanBody, "chore(monitoring): define the policies as code"),
			ctx,
		);
		expect(result && "block" in result).toBe(true);
		if (result && "block" in result) {
			expect(result.reason).toContain("conventional commit");
		}
	});
});
