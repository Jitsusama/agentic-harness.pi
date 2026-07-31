/**
 * One shape for a tool call line, across every surface that draws one.
 *
 * The fake marks each role rather than colouring anything, so a test can assert
 * which half of the line is emphasised. That is the whole point of the change: the
 * tool is bold so the eye finds it, and everything after it is not, so the
 * emphasis means something.
 */

import { describe, expect, it } from "vitest";
import { type RenderTheme, renderToolCall } from "../../../lib/ui/tool-call.js";

/** A theme that says what it was asked to do instead of doing it. */
const THEME: RenderTheme = {
	fg: (role, text) => `<${role}>${text}</${role}>`,
	bold: (text) => `<b>${text}</b>`,
};

/** The line as a reader would see it, with the markup kept. */
function drawn(line: Parameters<typeof renderToolCall>[0]): string {
	const text = renderToolCall(line, THEME);
	// Text keeps what it was given; reading it back is how we check the line
	// rather than the call.
	return (text as unknown as { text: string }).text;
}

describe("a tool call line", () => {
	it("bolds the tool and nothing else", () => {
		const line = drawn({ tool: "work", action: "restack", subject: "main" });

		// The tool is the anchor, so it carries the emphasis.
		expect(line).toContain("<b>work</b>");
		// The action is plain, so it reads as that tool's own word rather than
		// competing with it. Emphasis on both halves is emphasis on neither.
		expect(line).not.toContain("<b>restack");
		expect(line).toContain(" restack");
	});

	it("dims the subject", () => {
		const line = drawn({ tool: "work", action: "status", subject: "fix-410" });

		expect(line).toContain("<dim> fix-410</dim>");
	});

	it("reads as itself when there is nothing else to say", () => {
		// A verb with no arguments should not leave a gap where they would be.
		expect(drawn({ tool: "review" })).toBe(
			"<toolTitle><b>review</b></toolTitle>",
		);
	});

	it("appends notes in order, all dim", () => {
		const line = drawn({
			tool: "browser see",
			action: "page",
			notes: ["across 3 widths", "[mobile]"],
		});

		expect(line.indexOf("across 3 widths")).toBeLessThan(
			line.indexOf("[mobile]"),
		);
		expect(line).toContain("<dim> across 3 widths</dim>");
		expect(line).toContain("<dim> [mobile]</dim>");
	});

	it("clips a subject that would run the line off the screen", () => {
		const long = "a".repeat(200);
		const line = drawn({ tool: "work", action: "record", subject: long });

		// A real ellipsis, because this marks elision, which is the one place the
		// character earns its keep over three periods.
		expect(line).toContain("…");
		expect(line.length).toBeLessThan(long.length);
	});

	it("flattens a subject that spans lines", () => {
		// A commit body or a selector can arrive with newlines in it, and a call
		// line that becomes three lines is no longer a call line.
		const line = drawn({
			tool: "work",
			action: "record",
			subject: "first\n\nsecond",
		});

		expect(line).not.toContain("\n");
		expect(line).toContain("first second");
	});
});
