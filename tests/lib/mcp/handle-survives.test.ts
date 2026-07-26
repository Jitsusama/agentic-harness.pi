/**
 * A cited handle has to resolve, however tight the ceiling was.
 *
 * This is the regression CI found. The notice that names where a
 * payload went was sliced to fit the byte limit, which cut the
 * handle in half. The caller reads something that looks exactly
 * like a handle, queries it, and is told it is no longer
 * available, which is indistinguishable from an expired one.
 *
 * It went unnoticed for as long as handles happened to fit. A
 * rename that made them one byte longer pushed one over a tight
 * limit, and the failure surfaced somewhere else entirely.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceResultCeiling } from "../../../lib/mcp/ceiling.js";
import { createResultStore } from "../../../lib/mcp/store.js";
import type { McpContent, McpToolResult } from "../../../lib/mcp/types.js";

describe("a handle in a capped notice", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "handle-survives-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** The text a result puts in front of the model. */
	function textOf(content: McpContent[]): string {
		return content
			.filter((b): b is Extract<McpContent, { type: "text" }> => {
				return b.type === "text";
			})
			.map((b) => b.text)
			.join("\n");
	}

	it("still resolves when the limit barely fits the notice", () => {
		const store = createResultStore({ dir });
		// Comfortably over every limit below, so the ceiling always
		// engages and a notice is always written. The first version of
		// this test used a payload smaller than the limits, so nothing was
		// capped and it failed for a reason that had nothing to do with
		// handles.
		const payload = JSON.stringify({
			status: "ok",
			events: Array.from({ length: 200 }, (_, i) => i),
		});
		const content: McpContent[] = [{ type: "text", text: payload }];
		const raw: McpToolResult = { content };

		// Limits chosen around the notice's own length, which is where
		// the slicing used to land mid-handle.
		for (const limitBytes of [80, 120, 160, 200, 240]) {
			const out = enforceResultCeiling(content, raw, {
				limitBytes,
				spill: (text) => store.put(text),
			});
			const notice = textOf(out);
			const cited = /handle ([\w-]+)/.exec(notice)?.[1];

			expect(cited, `no handle cited at ${limitBytes} bytes`).toBeDefined();
			// The handle the notice names must be the whole handle: read
			// it back exactly as a caller would.
			expect(
				store.read(cited as string),
				`handle cut at ${limitBytes} bytes`,
			).toBe(payload);
		}
	});
});
