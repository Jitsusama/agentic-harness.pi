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
import { promptSingle, promptTabbed } from "../../lib/ui/panel.js";
import { formatRedirectReason } from "../../lib/ui/redirect.js";
import { wordWrap } from "../../lib/ui/text-layout.js";
import type { ContentRenderer, PromptResult } from "../../lib/ui/types.js";
import { type GatePanel, gateLines, gateText } from "./render.js";

/** Narrower than this and wrapping does more harm than the overflow. */
const MIN_WRAP = 20;

/**
 * How wide the panel is assumed to have been when quoting it back.
 *
 * The real width belongs to a terminal that has already gone by the time a
 * redirect is being written up, and the quote is read by a model rather
 * than laid out on screen, so a settled width beats a remembered one.
 */
const REDIRECT_QUOTE_WIDTH = 72;
const REJECT_KEY = "r";

/** What both prompts report for a plain Enter. Their sentinel, not ours. */
const SUBMIT_KEY = "__enter__";
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

/**
 * What a person decided about a batch, item by item.
 *
 * Three states, and the difference between two of them is why this is not
 * a list of booleans. A tab is approved when Enter was pressed on it,
 * rejected when `r` was, and untouched when neither happened. Untouched
 * means send: the items were composed in one breath and shown in one
 * panel, so submitting early sends the rest as they stand. That diverges
 * from the Slack gate, which treats an early submit as a cancel so that
 * nothing unseen goes out. The difference is deliberate: this panel has
 * already shown everything, and six Enters is the tax being removed.
 */
export interface BatchDecision {
	/** False when the panel was cancelled or redirected. Nothing sends. */
	proceed: boolean;
	/** Labels to send: approved plus untouched, in the order given. */
	accepted: string[];
	/** Labels explicitly rejected. Dropped, never sent. */
	rejected: string[];
	/** A redirect note, or a note left on a rejection. */
	redirect?: string;
}

/**
 * One way of looking at a gate item.
 *
 * A `PromptItem` view may render asynchronously, and this cannot: a batch
 * of one is asked as a plain panel, and a plain panel's content renderer
 * is synchronous. Everything here is drawn from data already in hand, so
 * the narrower type costs nothing and keeps the fall-through honest.
 */
export interface GateView {
	/** Number key, per the keybinding guide: "1", "2". */
	key: string;
	/** Footer label: "Remark", "Anchor", "Thread". */
	label: string;
	content: ContentRenderer;
	/** True for code, which must not wrap. */
	allowHScroll?: boolean;
}

/** One thing a gate is about. */
export interface GateItem {
	/** Tab label, and the address reported in the decision: "T26", "F2". */
	label: string;
	/** First view is the default. */
	views: GateView[];
	allowHScroll?: boolean;
}

/**
 * Ask about several writes at once, a tab each.
 *
 * One item is asked as a single panel rather than a one-tab batch, so the
 * simple case gains no ceremony, and it answers in the same shape so no
 * caller has to branch on the count.
 */
export async function confirmBatch(
	ctx: ExtensionContext,
	title: string,
	items: GateItem[],
): Promise<BatchDecision> {
	const labels = items.map((item) => item.label);
	if (!ctx.hasUI) return { proceed: true, accepted: labels, rejected: [] };

	if (items.length === 1) return await single(ctx, title, items[0], labels);

	const answer = await promptTabbed(ctx, {
		title,
		items,
		actions: REJECT,
	});
	if (!answer) return abandoned();

	const accepted: string[] = [];
	const rejected: string[] = [];
	let note: string | undefined;

	for (const [at, label] of labels.entries()) {
		const said = answer.items.get(at);
		const decision = decisionOf(said ?? untouched());
		// One steer abandons the batch: the items were composed together, so
		// changing one of them means composing them again.
		if (said?.type === "redirect") {
			return { ...abandoned(), redirect: said.note };
		}
		if (decision.approved) {
			accepted.push(label);
		} else {
			rejected.push(label);
			if (decision.redirect) note = decision.redirect;
		}
	}
	return { proceed: true, accepted, rejected, redirect: note };
}

/** One item, asked as a plain panel. */
async function single(
	ctx: ExtensionContext,
	title: string,
	item: GateItem | undefined,
	labels: string[],
): Promise<BatchDecision> {
	const decision = decisionOf(
		await promptSingle(ctx, {
			title,
			content: (theme, width) => item?.views[0]?.content(theme, width) ?? [],
			actions: REJECT,
		}),
	);
	return decision.approved
		? { proceed: true, accepted: labels, rejected: [] }
		: {
				proceed: false,
				accepted: [],
				rejected: labels,
				redirect: decision.redirect,
			};
}

/** Nothing sends. */
function abandoned(): BatchDecision {
	return { proceed: false, accepted: [], rejected: [] };
}

/** A tab nobody pressed anything on, which reads as approval here. */
function untouched(): PromptResult {
	return { type: "action", key: SUBMIT_KEY };
}

/** A note with words in it, or nothing. Whitespace is not an instruction. */
function said(note: string | undefined): string | undefined {
	const trimmed = note?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Ask the user to approve one write. Enter approves.
 *
 * A panel is the shape to reach for: it draws the four parts every gate
 * has and the redirect quotes it back. A bare string is the older shape,
 * kept for the gates in `offer.ts`, which are about a change rather than
 * about something somebody said and have nothing to quote.
 */
export async function confirmWrite(
	ctx: ExtensionContext,
	title: string,
	body: string | GatePanel,
): Promise<GateDecision> {
	if (!ctx.hasUI) return { approved: true };
	const decision = decisionOf(
		await promptSingle(ctx, {
			title,
			content: (theme, width) =>
				typeof body === "string"
					? wordWrap(body, Math.max(MIN_WRAP, width))
					: gateLines(body, theme, width),
			actions: REJECT,
		}),
	);
	if (decision.approved || !decision.redirect) return decision;
	const shown =
		typeof body === "string" ? body : gateText(body, REDIRECT_QUOTE_WIDTH);
	return {
		approved: false,
		redirect: formatRedirectReason(decision.redirect, `${title}\n\n${shown}`),
	};
}
