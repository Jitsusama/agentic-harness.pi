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

	it("survives in a block an earlier layer already wrote", () => {
		// This is the shape CI actually failed on. An upstream layer had
		// already stashed a payload and said so in its own text, which
		// arrives here as ordinary head text rather than as the notice.
		// Slicing the head cut that citation in half.
		//
		// This spent a while committed as a skipped test, because the
		// version I first wrote put the citation in a 186-byte head and
		// swept limits from 180 to 560. With the guard removed it still
		// passed: a head that small is either kept or dropped whole, so
		// no cut ever landed inside the handle and the sweep proved
		// nothing. The fixture was the problem, not the idea.
		//
		// The head has to be large enough to be sliced, with the
		// citation buried far enough in that a cut can fall through it.
		// With the guard removed, this fixture fails at twenty-two
		// consecutive budgets, which is the width of a handle.
		const store = createResultStore({ dir });
		const payload = JSON.stringify({
			deep: Array.from({ length: 50 }, () => 1),
		});
		const stored = store.put(payload);
		const pad = "prose that fills the head so a cut can land in it. ".repeat(
			40,
		);
		const head = `${pad}[stashed under handle ${stored.handle}] ${pad}`;
		const content: McpContent[] = [{ type: "text", text: head }];

		// Every byte, over a range derived from the fixture rather than
		// chosen. The window where a cut lands inside the handle is only
		// as wide as the handle, and where it sits depends on the length
		// of the notice, which quotes a temp path and so differs between
		// a laptop and a runner. That is what made the original failure
		// invisible locally, and it is why nothing here is hardcoded.
		for (let limitBytes = 40; limitBytes <= head.length + 600; limitBytes++) {
			const out = enforceResultCeiling(
				content,
				{ content },
				{ limitBytes, spill: (text) => store.put(text) },
			);

			for (const cited of textOf(out).matchAll(/handle ([\w-]+)/g)) {
				// Every handle named anywhere in the answer must resolve. A
				// prefix that merely looks like one is the whole defect: the
				// caller queries it and is told it has expired.
				expect(
					() => store.read(cited[1] as string),
					`handle ${cited[1]} cut at ${limitBytes} bytes`,
				).not.toThrow();
			}
		}
	});
});
