import { describe, expect, it } from "vitest";
import type { Stack } from "../../../extensions/pr-workflow/stack.js";
import { formatReviewStackContext } from "../../../extensions/pr-workflow/stack-context.js";

function entry(number: number, title: string) {
	return {
		reference: { owner: "o", repo: "r", number },
		title,
		baseRefName: "b",
		headRefName: "h",
	};
}

describe("formatReviewStackContext", () => {
	it("returns undefined for no stack or a lone PR", () => {
		expect(formatReviewStackContext(null)).toBeUndefined();
		const solo: Stack = {
			entries: [entry(1, "Only")],
			cursorIndex: 0,
			cursorChildren: [],
		};
		expect(formatReviewStackContext(solo)).toBeUndefined();
	});

	it("summarizes the stack, marks the cursor and warns off sibling review", () => {
		const stack: Stack = {
			entries: [
				entry(101, "Base work"),
				entry(102, "Cursor"),
				entry(103, "Child"),
			],
			cursorIndex: 1,
			cursorChildren: [],
		};
		const text = formatReviewStackContext(stack);
		expect(text).toContain("3-PR stack");
		expect(text).toContain("#101");
		expect(text).toContain("▶ #102 (this PR)");
		expect(text).toContain("#103");
		expect(text?.toLowerCase()).toContain("do not review their code");
	});
});
