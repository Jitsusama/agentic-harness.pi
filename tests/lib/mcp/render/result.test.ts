import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	CANCELLED_TEXT,
	classifyResult,
	collapsePreview,
	resultText,
} from "../../../../lib/mcp/render/result.js";

function textResult(...texts: string[]): AgentToolResult<unknown> {
	return {
		content: texts.map((text) => ({ type: "text", text })),
		details: undefined,
	};
}

describe("resultText", () => {
	it("joins the text blocks and ignores others", () => {
		const result: AgentToolResult<unknown> = {
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "b" },
			],
			details: undefined,
		};
		expect(resultText(result)).toBe("a\nb");
	});
});

describe("classifyResult", () => {
	it("classifies an errored call as error regardless of text", () => {
		expect(classifyResult("anything", true)).toBe("error");
	});

	it("classifies the owned cancel sentinel as cancel", () => {
		expect(classifyResult(CANCELLED_TEXT, false)).toBe("cancel");
	});

	it("classifies ordinary output as preview", () => {
		expect(classifyResult("some rows", false)).toBe("preview");
	});
});

describe("collapsePreview", () => {
	it("keeps everything when within the preview budget", () => {
		expect(collapsePreview("1\n2\n3", 6)).toEqual({
			lines: ["1", "2", "3"],
			hiddenCount: 0,
		});
	});

	it("keeps the first N lines and counts the rest", () => {
		const text = ["1", "2", "3", "4", "5"].join("\n");
		expect(collapsePreview(text, 3)).toEqual({
			lines: ["1", "2", "3"],
			hiddenCount: 2,
		});
	});

	it("reads its text from a result via resultText", () => {
		const text = resultText(textResult("only one line"));
		expect(collapsePreview(text, 6).hiddenCount).toBe(0);
	});
});
