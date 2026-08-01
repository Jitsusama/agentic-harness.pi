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
 *
 * A gate can also be argued with. `Shift+Escape` redirects and
 * `Shift+r` annotates a rejection, and both hand back a sentence
 * saying what to do instead. The decision type is the one the
 * Google Workspace confirmation already returns, because a person
 * moving between the two should not have to learn a second answer
 * to the same question.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { promptSingle } from "../../lib/ui/panel.js";
import { formatRedirectReason } from "../../lib/ui/redirect.js";
import { wordWrap } from "../../lib/ui/text-layout.js";
import type { PromptResult } from "../../lib/ui/types.js";

/** Narrower than this and wrapping does more harm than the overflow. */
const MIN_WRAP = 20;
const REJECT_KEY = "r";
const REJECT = [{ key: REJECT_KEY, label: "Reject" }];

/**
 * What a person decided at a write gate.
 *
 * On a refusal, `redirect` is what to hand back to the model: from
 * `confirmWrite` it is already wrapped in its instruction, since
 * the gate holds the context that makes a note make sense.
 */
export type GateDecision = GateApproval | GateRefusal;

/** A go-ahead, carrying anything said while giving it. */
export interface GateApproval {
	approved: true;
	note?: string;
}

/** A no, carrying what to do instead when somebody said. */
export interface GateRefusal {
	approved: false;
	redirect?: string;
}

/**
 * Read a panel result as a decision about the write behind it.
 *
 * A redirect is a refusal that says what to do instead, and so is a
 * rejection somebody bothered to annotate: both hand their note back
 * for the model to read as an instruction. Only a submit approves,
 * and it carries its own note through to the transcript.
 *
 * The note comes back as it was said. Wrapping it in context is
 * `confirmWrite`'s job, since the context is the panel it showed.
 */
export function decisionOf(result: PromptResult | null): GateDecision {
	// Escape cancels, which counts as a refusal.
	if (!result) return { approved: false };

	const note = said("note" in result ? result.note : undefined);

	if (result.type === "redirect") return { approved: false, redirect: note };
	if (result.type === "action" && result.key === REJECT_KEY) {
		return { approved: false, redirect: note };
	}
	return note ? { approved: true, note } : { approved: true };
}

/** A note with words in it, or nothing. Whitespace is not an instruction. */
function said(note: string | undefined): string | undefined {
	const trimmed = note?.trim();
	return trimmed ? trimmed : undefined;
}

/** Ask the user to approve one write. Enter approves. */
export async function confirmWrite(
	ctx: ExtensionContext,
	title: string,
	body: string,
): Promise<GateDecision> {
	if (!ctx.hasUI) return { approved: true };
	const decision = decisionOf(
		await promptSingle(ctx, {
			title,
			content: (_theme, width) => wordWrap(body, Math.max(MIN_WRAP, width)),
			actions: REJECT,
		}),
	);
	if (decision.approved || !decision.redirect) return decision;
	return {
		approved: false,
		redirect: formatRedirectReason(decision.redirect, `${title}\n\n${body}`),
	};
}
