/**
 * The changes a session put up itself, which never go on the person's
 * look list. Joel, 24 November, of a draft PR a session pointed him at:
 * "don't fucking put prs in my look list, review it your fucking self
 * and take it out of draft and ask for review wheeen you are comfortable
 * with it." A session's own change is reviewed by its own councils and
 * asked of reviewers; pointing him at it hands him the work.
 */

import { isRecord } from "../../internal/record.ts";

/** The tool a session proposes its changes with. */
const PROPOSING_TOOL = "review_offer";

/**
 * The URLs of the changes a session proposed, read from its log's
 * branch: each review_offer answer that names one or several.
 */
export function proposedIn(entries: readonly unknown[]): string[] {
	const urls: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (message.toolName !== PROPOSING_TOOL) continue;
		const details = message.details;
		if (!isRecord(details)) continue;
		const one = details.url;
		if (typeof one === "string" && one !== "") urls.push(one);
		const several = details.urls;
		if (Array.isArray(several)) {
			for (const url of several) {
				if (typeof url === "string" && url !== "") urls.push(url);
			}
		}
	}
	return urls;
}

/**
 * Whether `target` opens one of `proposed`, or a tab, diff or comment
 * of one, as `…/pull/12/files` or `…/pull/12#discussion` is of
 * `…/pull/12`, but `…/pull/123` is not.
 */
export function opensOneOf(
	target: string,
	proposed: readonly string[],
): boolean {
	const opened = target.trim();
	return proposed.some((url) => {
		const change = url.trim().replace(/\/+$/, "");
		if (change === "" || !opened.startsWith(change)) return false;
		const next = opened.charAt(change.length);
		return next === "" || next === "/" || next === "#" || next === "?";
	});
}

/** What a session is told when it points the person at its own change. */
export const OWN_CHANGE_REFUSED =
	"This session proposed that change, and the person reviews no change his sessions put up (Joel, 24 November: review it yourself, take it out of draft and ask for review when you are comfortable with it). Have a council read it, fix what holds, mark it ready and ask its reviewers with review_offer; what only he can decide goes to the orchestrator as a question.";
