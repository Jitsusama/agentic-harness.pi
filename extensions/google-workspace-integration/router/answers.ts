/**
 * The answers every handler gives alike: a call missing what it
 * needs, and a gate the person didn't pass.
 */

import type { ToolResult } from "../../../lib/google/types.ts";
import { OUTCOME_GLYPH } from "../../../lib/ui/outcome-glyphs.ts";
import type { ConfirmResult } from "../confirmation.ts";

/** An answer that is only words. */
export function said(text: string): ToolResult {
	return { content: [{ type: "text", text }] };
}

/** The answer to a call that left out what it needs, by name. */
export function missing(...names: string[]): ToolResult {
	const noun = names.length === 1 ? "parameter" : "parameters";
	return said(`Missing required ${noun}: ${names.join(", ")}`);
}

/**
 * The answer when the person didn't pass a gate: `cancelled` when
 * they cancelled it, and their redirect when they sent the agent back.
 */
export function unconfirmed(
	result: Exclude<ConfirmResult<unknown>, { approved: true }>,
	cancelled: string,
): ToolResult {
	if (!result) return said(`${OUTCOME_GLYPH.cancelled} ${cancelled}`);
	return said(result.redirect);
}
