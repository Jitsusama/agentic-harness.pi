/**
 * Image Budget Workflow extension.
 *
 * Brings images entering the context window down to the resolution a
 * human could actually see, before they are billed for every remaining
 * turn of the session.
 *
 * A provider bills an image by its dimensions, not its payload: a
 * 415,508-character base64 image billed 1,789 tokens against a real
 * response. So a screenshot from a 2x Retina display costs about 5,441
 * tokens where its logical rendering costs 1,361. Those extra pixels are
 * device redundancy, and the logical rendering is the thing that was on
 * screen and read, which makes discarding them information-preserving
 * rather than a quality trade. That is what makes this safe to do
 * without asking.
 *
 * pi already resizes to 2000x2000 and the dimension is not
 * configurable, so this takes the remaining step. It runs at
 * `tool_result`, which is where a clipboard paste arrives, since a
 * pasted image reaches the model as a `read` of a temp file.
 *
 * The money is not the point. The habit of pasting screenshots had been
 * given up to avoid a price nobody had measured, which is a capability
 * traded away for an unmeasured cost, and is exactly the failure this
 * work exists to prevent. The aim is pasting freely at a quarter of the
 * price.
 */

import { readFile } from "node:fs/promises";
import {
	type ExtensionAPI,
	resizeImage,
} from "@earendil-works/pi-coding-agent";
import { type LoadOriginal, type Resize, rebudget } from "./rebudget.ts";

/** pi's resizer, narrowed to the shape this extension needs. */
const resize: Resize = (bytes, mimeType, options) =>
	resizeImage(bytes, mimeType, options);

/**
 * The file a `read` names, when it named one. Re-encoding from the
 * source is one compression rather than pi's with ours stacked on top,
 * which is the difference between a picture that has been through two
 * lossy passes and one that has been through a single.
 */
function originalFrom(input: unknown): LoadOriginal | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const path = (input as Record<string, unknown>).path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	return async () => {
		try {
			return await readFile(path);
		} catch {
			// The file may be gone, or may never have been local. The
			// payload is still there, so this costs a compression and not
			// the picture.
			return null;
		}
	};
}

export default function imageBudgetWorkflow(pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const blocks = event.content;
		if (!Array.isArray(blocks)) return;
		// Most results carry no image at all, so the common path is one
		// scan of a short array and no decoding.
		if (!blocks.some((block) => block.type === "image")) return;

		const { content } = await rebudget(
			blocks,
			resize,
			originalFrom(event.input),
		);
		// Returning nothing keeps the result exactly as it was, which is
		// what every path that could not help has to do.
		if (!content) return;
		return { content };
	});
}
