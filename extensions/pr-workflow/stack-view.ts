/**
 * Read-only navigation helpers for a discovered PR
 * stack.
 *
 * The stack discovery walker (`stack.ts`) builds the
 * shape; this module renders it for the conversation
 * surface and provides cursor-relative pickers
 * (`nextInStack`, `prevInStack`).
 *
 * Pure. No I/O. The action handlers in `index.ts` use
 * these picks to re-invoke `loadPr` on the adjacent
 * entry.
 */

import type { Stack, StackEntry } from "./stack.js";

const CURSOR_GLYPH = "\u25b6"; // ▶
const ENTRY_GLYPH = " ";

/**
 * Render the stack as a prose tree the agent can show
 * the user. Highlights the cursor row; reports fan-out
 * children as a footer when applicable.
 */
export function formatStack(stack: Stack): string {
	const lines: string[] = [];
	for (let i = 0; i < stack.entries.length; i++) {
		lines.push(renderRow(stack.entries[i], i === stack.cursorIndex));
	}
	if (stack.cursorChildren.length > 0) {
		lines.push("");
		lines.push(
			`Cursor has fan-out: ${stack.cursorChildren.length} downstream branches:`,
		);
		for (const child of stack.cursorChildren) {
			lines.push(renderRow(child, false));
		}
	}
	return lines.join("\n");
}

function renderRow(entry: StackEntry, isCursor: boolean): string {
	const marker = isCursor ? CURSOR_GLYPH : ENTRY_GLYPH;
	const chain = `${entry.baseRefName} \u2190 ${entry.headRefName}`;
	const cursorTag = isCursor ? " (cursor)" : "";
	return `  ${marker} #${entry.reference.number} ${entry.title} [${chain}]${cursorTag}`;
}

/**
 * Pick the next entry downstream of the cursor.
 *
 * Returns `null` when the cursor is the last entry OR
 * when the cursor has fan-out children (multiple
 * candidates make "next" ambiguous; the agent has to
 * ask the user which one).
 */
export function nextInStack(stack: Stack): StackEntry | null {
	if (stack.cursorChildren.length > 0) return null;
	const next = stack.entries[stack.cursorIndex + 1];
	return next ?? null;
}

/**
 * Pick the previous entry upstream of the cursor. Returns
 * `null` when the cursor is the first entry.
 */
export function prevInStack(stack: Stack): StackEntry | null {
	const prev = stack.entries[stack.cursorIndex - 1];
	return prev ?? null;
}
