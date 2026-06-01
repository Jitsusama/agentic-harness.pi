import { describe, expect, it } from "vitest";
import { violationSignature } from "../../../lib/gate/index.js";
import {
	detectSlackViolations,
	formatSlackBlock,
	slackGateDecision,
} from "../../../lib/slack/index.js";

describe("formatSlackBlock", () => {
	it("returns an empty string when there are no violations", () => {
		expect(formatSlackBlock([])).toBe("");
	});

	it("names the image, table and list problems and points at the skill", () => {
		const text = ["![x](y.png)", "| a | b |", "| --- | --- |"].join("\n");
		const message = formatSlackBlock(detectSlackViolations(text));
		expect(message).toMatch(/upload_file/);
		expect(message).toMatch(/table parameter/);
		expect(message).toContain("slack-guide");
	});
});

describe("slackGateDecision", () => {
	it("allows a clean message", () => {
		expect(slackGateDecision("Just some prose.", []).action).toBe("allow");
	});

	it("blocks a malformed table the first time", () => {
		const text = ["| a | b |", "| --- | --- |"].join("\n");
		const decision = slackGateDecision(text, []);
		expect(decision.action).toBe("block");
		expect(decision.message).toMatch(/table parameter/);
	});

	it("relents when the same problem was already blocked", () => {
		const text = ["| a | b |", "| --- | --- |"].join("\n");
		const sig = violationSignature(detectSlackViolations(text));
		const decision = slackGateDecision(text, [sig]);
		expect(decision.action).toBe("relent");
		expect(decision.message).toMatch(/still|remaining|yourself/i);
	});
});
