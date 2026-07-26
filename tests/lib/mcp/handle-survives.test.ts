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

	// The companion case, a citation an earlier layer wrote into the
	// head rather than into the notice, is guarded by
	// `tests/lib/mcp/surface/manager.test.ts`, which is where CI caught
	// it and where reverting `headWithin` fails immediately under a
	// short TMPDIR. I tried to reproduce it here synthetically and
	// could not: sweeping every byte from 180 to 560 never landed a cut
	// inside the handle, so what I had written passed with the fault
	// present. A test that cannot be shown to fail is not protection,
	// it only looks like it, so it is not here.
	it.skip("survives in a block an earlier layer already wrote", () => {
		// This is the shape CI actually failed on. An upstream layer had
		// already stashed a payload and said so in its own text, which
		// arrives here as ordinary head text rather than as the notice.
		// Slicing the head cut that citation in half.
		//
		// It passed on my machine and failed on CI for a reason that has
		// nothing to do with either: the notice quotes a filesystem path,
		// a temp directory is longer on macOS than on a runner, and the
		// cut landed in a different place. Reproduced locally only by
		// pointing TMPDIR somewhere short.
		const store = createResultStore({ dir });
		const payload = JSON.stringify({
			deep: Array.from({ length: 50 }, () => 1),
		});
		const stored = store.put(payload);
		const content: McpContent[] = [
			{ type: "text", text: "summary of something" },
			{
				type: "text",
				text: `[Full JSON stashed under handle ${stored.handle} (${stored.path}); query it.]`,
			},
		];

		// Every byte across a wide range, not a handful of round
		// numbers. The window where the cut lands inside the handle is
		// only as wide as the handle, and its position depends on the
		// length of a temp path, which is exactly why this failed on a
		// runner and not on my machine. Stepping by twenty stepped over
		// it and looked like proof.
		for (let limitBytes = 180; limitBytes <= 560; limitBytes += 1) {
			const out = enforceResultCeiling(
				content,
				{ content },
				{ limitBytes, spill: (text) => store.put(text) },
			);

			for (const cited of textOf(out).matchAll(/handle ([\w-]+)/g)) {
				// Every handle named anywhere in the answer must resolve. A
				// prefix that merely looks like one is the whole defect.
				expect(
					() => store.read(cited[1] as string),
					`handle ${cited[1]} cut at ${limitBytes} bytes`,
				).not.toThrow();
			}
		}
	});
});
