/**
 * An edit whose old text was not found is told what the file holds, so
 * the retry can be right without reading the file again.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import editEscapeInterceptor from "../../extensions/edit-escape-interceptor/index.ts";
import {
	missedEditHint,
	nearest,
} from "../../extensions/edit-escape-interceptor/missed.ts";

const FILE = [
	"function settle() {",
	"\tconst slot = reloadSlot();",
	"\tif (slot.request) return;",
	"\tslot.dispatched = true;",
	"}",
	"",
	"function other() {}",
].join("\n");

describe("the lines closest to a missed old text", () => {
	it("quotes the region whose lines cover it, as the file spells them", () => {
		const oldText = "  const slot = reloadSlot();\n  if (slot.request) return;";

		expect(nearest(FILE, oldText)).toEqual({
			start: 2,
			end: 3,
			lines: ["\tconst slot = reloadSlot();", "\tif (slot.request) return;"],
		});
	});

	it("quotes nothing when under half its lines are anywhere near", () => {
		const oldText = "\tconst slot = reloadSlot();\nnothing\nlike\nthis";

		expect(nearest(FILE, oldText)).toBeUndefined();
	});
});

describe("the hint beside a missed edit", () => {
	it("says an edit whose new text is in and old text is not looks applied", () => {
		const hint = missedEditHint(
			FILE,
			"\tslot.dispatched = false;",
			"\tslot.dispatched = true;",
			"edits[1]",
		);

		expect(hint).toMatch(/^edits\[1\]'s new text is already in the file/);
	});

	it("numbers the lines it quotes", () => {
		const hint = missedEditHint(
			FILE,
			"\tif (slot.request) return;\n\tslot.dispatched = false;\n}",
			"x",
			"the edit",
		);

		expect(hint).toContain(
			"3\t\tif (slot.request) return;\n4\t\tslot.dispatched = true;",
		);
	});
});

describe("an edit that missed", () => {
	let dir: string;
	let handler: (event: unknown, ctx: unknown) => Promise<unknown>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "edit-missed-"));
		const pi = {
			on: (name: string, listener: typeof handler) => {
				if (name === "tool_result") handler = listener;
			},
		};
		editEscapeInterceptor(pi as unknown as ExtensionAPI);
		writeFileSync(join(dir, "follow.ts"), FILE);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const result = (text: string, isError = true) => ({
		type: "tool_result",
		toolCallId: "t1",
		toolName: "edit",
		isError,
		details: undefined,
		input: {
			path: "follow.ts",
			edits: [
				{ oldText: "function settle() {", newText: "function settled() {" },
				{ oldText: "  if (slot.request) return;", newText: "x" },
			],
		},
		content: [{ type: "text", text }],
	});

	it("is answered with the lines closest to the edit pi named", async () => {
		const answer = await handler(
			result(
				"Could not find edits[1] in follow.ts. The oldText must match exactly.",
			),
			{ cwd: dir },
		);

		expect(answer).toMatchObject({
			content: [
				{ type: "text" },
				{
					type: "text",
					text: expect.stringContaining("3\t\tif (slot.request) return;"),
				},
			],
		});
	});

	it("is left alone when it failed for another reason", async () => {
		const answer = await handler(
			result("Found 2 occurrences of edits[1] in follow.ts."),
			{ cwd: dir },
		);

		expect(answer).toBeUndefined();
	});
});
