/**
 * Output Ceiling Workflow extension.
 *
 * Caps the size of a result from a fat-tailed tool, keeping a way back
 * to the part it cut.
 *
 * bash is not one of these: its results are uniformly small across the
 * real corpus, so a ceiling on it would never fire. `read`, `slack`,
 * `vault`, `grokt_bulk_search` and every `observe_*` tool have the
 * opposite shape: a typical result is small, but a rare one is
 * enormous, and that rare one pays rent on every remaining turn of a
 * long session regardless of whether the rest of the result ever gets
 * used again.
 *
 * This is a quality trade, not provable waste: the truncated remainder
 * might have been the part that mattered. So it is off by default,
 * behind `PI_OUTPUT_CEILING_CHARS`. Setting nothing changes nothing.
 * The full text is written to a temporary file before it is cut, the
 * same convention pi's own bash tool already uses for its truncated
 * output, so a truncated result is always recoverable by path.
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyCeiling } from "../../lib/reduction/index.js";

/** Tools with a documented fat tail in the real corpus. */
const FAT_TAIL_TOOLS = new Set(["read", "slack", "vault", "grokt_bulk_search"]);

function isFatTailed(toolName: string): boolean {
	return FAT_TAIL_TOOLS.has(toolName) || toolName.startsWith("observe_");
}

/** Read the ceiling from the environment. Unset or non-positive disables this entirely. */
function configuredCeiling(): number | undefined {
	const raw = process.env.PI_OUTPUT_CEILING_CHARS;
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export default function outputCeilingWorkflow(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const maxChars = configuredCeiling();
		if (!maxChars) return;
		if (!isFatTailed(event.toolName)) return;

		const blocks = event.content;
		if (!Array.isArray(blocks)) return;

		let changed = false;
		const content = await Promise.all(
			blocks.map(async (block) => {
				if (block.type !== "text") return block;
				const result = applyCeiling(block.text, maxChars);
				if (!result.truncated || !result.digest) return block;

				const path = join(tmpdir(), `pi-output-ceiling-${result.digest}.txt`);
				await writeFile(path, block.text, "utf8");
				changed = true;
				return {
					...block,
					text: `${result.text}\n\n[Output truncated at ${maxChars} characters (original: ${result.originalChars}). Full output saved to ${path}]`,
				};
			}),
		);

		if (!changed) return;
		return { content };
	});
}
