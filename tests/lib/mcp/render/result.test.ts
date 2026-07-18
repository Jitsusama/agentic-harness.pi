import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { RESULT_VIEW_KEY } from "../../../../lib/mcp/json-summary.js";
import {
	CANCELLED_TEXT,
	classifyResult,
	collapsePreview,
	formatBytes,
	resultText,
	resultViewOf,
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

describe("resultViewOf", () => {
	it("reads a well-formed view off the result details", () => {
		const result: AgentToolResult<unknown> = {
			content: [],
			details: {
				[RESULT_VIEW_KEY]: {
					pretty: "{\n  a: number\n}",
					handle: "h1",
					path: "/tmp/x",
					bytes: 2048,
				},
			},
		};
		expect(resultViewOf(result)?.handle).toBe("h1");
	});

	it("ignores details with no view and malformed views", () => {
		expect(resultViewOf({ content: [], details: undefined })).toBeUndefined();
		expect(
			resultViewOf({ content: [], details: { [RESULT_VIEW_KEY]: 42 } }),
		).toBeUndefined();
		expect(
			resultViewOf({ content: [], details: { [RESULT_VIEW_KEY]: {} } }),
		).toBeUndefined();
	});
});

describe("formatBytes", () => {
	it("renders bytes, KB and MB across the thresholds", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(2_500_000)).toBe("2.4 MB");
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
