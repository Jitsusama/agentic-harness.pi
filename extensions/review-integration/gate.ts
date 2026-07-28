/**
 * Asking before writing.
 *
 * Every tool that changes something on someone else's change
 * pauses here first. This is what lets the authoring flows
 * eventually stop depending on shell guardians: the gate lives
 * where the action is, rather than downstream of a command line
 * that has to be parsed back into intent.
 *
 * Without a UI the gate approves, matching how the pr-workflow
 * gates behave headless. A tool run with no terminal has nobody
 * to ask, and refusing would make the substrate unusable from a
 * subagent.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptSingle } from "../../lib/ui/panel.js";

const REJECT = [{ key: "r", label: "Reject" }];

/** Ask the user to approve one write. Enter approves. */
export async function confirmWrite(
	ctx: ExtensionContext,
	title: string,
	body: string,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	const result = await promptSingle(ctx, {
		title,
		content: (_theme, width) => wrapAll(body, width),
		actions: REJECT,
	});
	// Escape cancels, which counts as a refusal; `r` rejects.
	if (!result) return false;
	return !(result.type === "action" && result.key === "r");
}

/** Wrap text to the panel width, keeping blank lines. */
function wrapAll(text: string, width: number): string[] {
	const usable = Math.max(20, width);
	return text.split("\n").flatMap((line) => wrapOne(line, usable));
}

function wrapOne(line: string, width: number): string[] {
	if (line.length <= width) return [line];
	const words = line.split(" ");
	const rows: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length > width && current) {
			rows.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) rows.push(current);
	return rows;
}
