/**
 * Whether a turn is worth reviewing.
 *
 * The advisor is bounded to substantive turns: ones that changed
 * something or took a consequential action. A turn that only read
 * or answered a question is not worth a paid review pass. The
 * signal is the set of tool names the turn invoked.
 */

/** Tool-name fragments that mark a turn as substantive. */
const SUBSTANTIVE_MARKERS = [
	"edit",
	"write",
	"apply_patch",
	"commit",
	"pr_",
	"post",
	"reply",
	"resolve",
	"merge",
	"rename",
	"delete",
];

/**
 * True when any tool name used in the turn signals a change or a
 * consequential action. Read-only tools (read, grep, glob, ls,
 * search) do not, so a purely investigative turn is skipped.
 */
export function isSubstantiveTurn(toolNames: string[]): boolean {
	return toolNames.some((name) => {
		const lower = name.toLowerCase();
		return SUBSTANTIVE_MARKERS.some((marker) => lower.includes(marker));
	});
}
