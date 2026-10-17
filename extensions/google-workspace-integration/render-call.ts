/**
 * Render tool call display for Google Workspace actions.
 *
 * The line is the package's one call line: the tool bold, the action
 * plain, what it was pointed at dim. Only the subject is Google's own,
 * worked out per action below.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { asText, renderToolCall } from "../../lib/ui/index.ts";

interface CallArgs {
	action?: string;
	query?: string;
	id?: string;
	to?: string[];
	subject?: string;
	summary?: string;
	start?: string;
	account?: string;
	attendees?: string[];
}

/**
 * Render a Google Workspace tool call with action-specific formatting.
 */
export function renderGoogleCall(
	args: unknown,
	theme: Theme,
	reuse?: unknown,
): Text {
	const a = args as CallArgs;
	// Non-default accounts get a visible label so the user knows which
	// one is active; the usual one is left unsaid, since a label on
	// every line stops being a signal.
	const notes =
		a.account && a.account !== "work" ? [`[${a.account}]`] : undefined;
	return renderToolCall(
		{ tool: "google", action: a.action || "?", subject: subjectOf(a), notes },
		theme,
		asText(reuse),
	);
}

/** What one action was pointed at, or nothing worth a glance. */
function subjectOf(a: CallArgs): string | undefined {
	switch (a.action) {
		case "get_email":
			return a.id;
		case "send_email": {
			const to = a.to ?? [];
			const more = to.length > 1 ? ` +${to.length - 1}` : "";
			const who = to.length > 0 ? `→ ${to[0]}${more}` : undefined;
			if (!a.subject) return who;
			return who ? `${who}: ${a.subject}` : a.subject;
		}
		case "create_draft":
			return a.subject ? `"${a.subject}"` : undefined;
		case "list_events":
			return a.start ? `from ${a.start}` : undefined;
		case "create_event": {
			const what = a.summary ? `"${a.summary}"` : "";
			const when = a.start ? `@ ${a.start}` : "";
			return [what, when].filter(Boolean).join(" ") || undefined;
		}
		case "check_availability": {
			const people = a.attendees ?? [];
			const names = people.slice(0, 3).join(", ");
			const more = people.length > 3 ? ` +${people.length - 3} more` : "";
			const who = names ? `${names}${more}` : "";
			const when = a.start ? `from ${a.start}` : "";
			return [who, when].filter(Boolean).join(" ") || undefined;
		}
		default:
			return a.query ? `"${a.query}"` : undefined;
	}
}
