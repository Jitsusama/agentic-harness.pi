/**
 * Saying several things on a change in one call, behind one gate.
 *
 * Everything `review_say` does comes through here, the singular parameters
 * included: they are read as a batch of one. One road rather than two that
 * agree today, because the bug this work came out of was two roads to the
 * same job disagreeing about part of it.
 *
 * A batch of one is still asked as a single panel, so the simple case
 * gains no ceremony. That falls out of `confirmBatch` rather than being
 * arranged here.
 */

import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Anchor,
	BoundTarget,
	ChangeRef,
	ConversationFacet,
	Reaction,
	Thread,
} from "../../../lib/review/index.js";
import { isReactableRefusal } from "../../../lib/review/index.js";
import { confirmBatch, type GateItem, REDIRECT_QUOTE_WIDTH } from "../gate.js";
import {
	anchorLabel,
	count,
	type GatePanel,
	type GateQuote,
	GLYPH,
	gateLines,
	gateText,
} from "../render.js";
import { type Settle, settleAfter, settleRefusal } from "./settle.js";
import { type Answer, findReactableOn, refuse, say } from "./shared.js";

/** One thing a batch was asked to say. */
export interface SayItem {
	action?: string;
	thread?: number;
	body?: string;
	settleThread?: Settle;
	comment?: string;
	reaction?: string;
	path?: string;
	line?: number;
	startLine?: number;
	side?: "old" | "new";
}

/**
 * Parameters that say where rather than what.
 *
 * Naming the change alongside a batch is not saying the same thing twice,
 * so these do not count as the singular form being used.
 */
const ADDRESSING = new Set(["action", "items", "change", "repo"]);

/**
 * Why this call cannot be read as a batch.
 *
 * Refused rather than resolved by precedence. A rule about which form wins
 * is a rule somebody has to know, and getting it wrong posts the other one.
 */
export function batchRefusal(
	params: Record<string, unknown> & { items?: SayItem[] },
): string | undefined {
	const { items } = params;
	if (!items) return undefined;

	if (items.length === 0) {
		return "That batch is empty. Put at least one thing in items, or use the singular parameters for one.";
	}

	const singular = Object.keys(params).filter(
		(key) => !ADDRESSING.has(key) && params[key] !== undefined,
	);
	if (singular.length > 0) {
		return `Say it once: this call carries both items and the singular ${singular.length === 1 ? "parameter" : "parameters"} ${singular.join(", ")}. Drop the singular ones and put that action in items.`;
	}

	for (const [at, item] of items.entries()) {
		if (!item.action) {
			// The top-level action is deliberately not a default. Otherwise a
			// batch of replies with one stray entry becomes a reply nobody wrote.
			return `Item ${at + 1} in items has no action. Every entry says what it is, since the top-level action does not carry into the batch.`;
		}
	}
	return undefined;
}

/**
 * How this entry is addressed in the answer, and in a refusal about it.
 *
 * By what a person can already see, never by an internal id. Reading
 * `[T26]` in an answer and `[T26]` in a threads listing has to mean the
 * same thread, or the address is decoration.
 *
 * This is not what the tab is labelled. An address is unique and often
 * long, which is what a transcript wants and what a strip of tabs cannot
 * afford; the strip carries a glyph for the kind instead.
 */
export function addressOf(item: SayItem, index: number): string {
	if (item.thread !== undefined) return `T${item.thread}`;
	if (item.comment) return item.comment;
	if (item.path) {
		return item.line === undefined
			? basename(item.path)
			: `${basename(item.path)}:${item.line}`;
	}
	if (item.action === "comment") return "the comment";
	return String(index + 1);
}

/**
 * What the tab is labelled: a mark for the kind of thing it is.
 *
 * Every label in a strip should be the same kind of token, and the three
 * vocabularies this used to mix, `T1` for a thread, `C1` for a comment
 * and the bare word `comment` for a new one, read as three unrelated
 * schemes sitting side by side. They also collided, since two new
 * comments were both called the same thing.
 *
 * A glyph says what the item is, and the strip's own running number says
 * which one, so the sequence belongs to the batch rather than restarting
 * per kind. Every glyph here is one the review family already owns.
 */
export function glyphOf(item: SayItem): string {
	if (item.action === "react") return GLYPH.reaction;
	if (item.action === "resolve") return GLYPH.resolved;
	if (item.action === "unresolve") return GLYPH.unresolved;
	if (item.action === "annotate") return GLYPH.thread;
	if (item.action === "comment") return GLYPH.document;
	return GLYPH.reply;
}

/**
 * The gate's first line, which alone says what pressing Enter does.
 *
 * A Title Case phrase naming the act, the way every other gate in the
 * package titles itself. Not a question: the panel is already asking one
 * and its footer says so, and a title that asks it again reads as a
 * different application's dialog.
 */
export function batchTitle(items: SayItem[], change: string): string {
	const only = items.length === 1 ? items[0] : undefined;
	// Always plural here: one item takes the branches below.
	if (!only) return `Post ${items.length} Things on ${change}`;
	if (only.action === "comment") return "Post a Comment";
	if (only.action === "react") return `React With ${only.reaction}`;
	if (only.action === "resolve") return "Resolve This Thread";
	if (only.action === "unresolve") return "Reopen This Thread";
	if (only.action === "annotate") return "Start a Thread Here";
	if (only.settleThread === "resolve") {
		return "Post This Reply and Resolve the Thread";
	}
	if (only.settleThread === "unresolve") {
		return "Post This Reply and Reopen the Thread";
	}
	return "Post This Reply";
}

/** Everything one entry needs, once its references have been resolved. */
interface Resolved {
	item: SayItem;
	/** What the transcript calls it: "T26", "C4", "the comment". */
	address: string;
	panel: GatePanel;
	/** Runs it, and says what happened. */
	perform: () => Promise<string>;
}

/**
 * Say everything in the batch, behind one gate.
 *
 * References are resolved before the gate opens and against one read of
 * the conversation, so `[T26]` cannot mean two different threads inside
 * one call, and so a batch that cannot run is refused before any of it
 * has been posted.
 */
export async function runBatch(
	ctx: ExtensionContext,
	bound: BoundTarget,
	conversation: ConversationFacet,
	change: ChangeRef,
	threads: Thread[],
	items: SayItem[],
): Promise<Answer> {
	const resolved: Resolved[] = [];
	for (const [at, item] of items.entries()) {
		const one = await resolveOne(
			bound,
			conversation,
			change,
			threads,
			item,
			at,
		);
		if (typeof one === "string") return refuse(one);
		resolved.push(one);
	}

	const gateItems: GateItem[] = resolved.map((one) => ({
		label: glyphOf(one.item),
		// The same panel as text, so a steer comes back attached to what
		// it was steering away from.
		plain: gateText(one.panel, REDIRECT_QUOTE_WIDTH),
		views: [
			{
				key: "1",
				label: viewLabel(one.item),
				content: (theme, width) => gateLines(one.panel, theme, width),
			},
		],
	}));

	const decision = await confirmBatch(
		ctx,
		batchTitle(items, change.label),
		gateItems,
	);
	if (!decision.proceed) {
		return decision.redirect
			? refuse(decision.redirect)
			: say(nothingSent(items));
	}

	const lines: string[] = [];
	for (const [at, one] of resolved.entries()) {
		if (decision.rejected.includes(at)) {
			lines.push(`${GLYPH.refused} ${one.address} dropped`);
			continue;
		}
		try {
			lines.push(await one.perform());
		} catch (error) {
			// The ones before it have already been posted, so this reports
			// rather than throws: a batch that half landed has to say which
			// half, and an exception here would lose the record.
			const said = error instanceof Error ? error.message : String(error);
			lines.push(`${GLYPH.failed} ${one.address} failed: ${said}`);
		}
	}
	return say(lines.join("\n"));
}

/** What was not sent, in the tool's own words. */
function nothingSent(items: SayItem[]): string {
	if (items.length > 1) return "Left unposted. Nothing was sent.";
	const only = items[0]?.action;
	return only === "resolve" || only === "unresolve" || only === "react"
		? "Left as it was."
		: "Left unposted.";
}

/** The footer label for an entry's only view. */
function viewLabel(item: SayItem): string {
	if (item.action === "react") return "Comment";
	if (item.action === "resolve" || item.action === "unresolve") return "Thread";
	if (item.action === "annotate") return "Remark";
	return "Reply";
}

/**
 * Work out what one entry refers to, or say why it cannot be done.
 *
 * Every refusal in here happens before the gate, because the alternative
 * is finding out mid-batch, with some of it already posted.
 */
async function resolveOne(
	bound: BoundTarget,
	conversation: ConversationFacet,
	change: ChangeRef,
	threads: Thread[],
	item: SayItem,
	at: number,
): Promise<Resolved | string> {
	const address = addressOf(item, at);
	const destination = `${change.label} \u00b7 ${bound.provider.id}`;

	if (item.action === "comment") {
		if (!item.body) return `${address}: a comment needs a body.`;
		const body = item.body;
		return {
			item,
			address,
			panel: { destination, payload: { body } },
			perform: async () => {
				const posted = await conversation.comment(change, body);
				return `${GLYPH.lands} posted${posted.url ? `\n   ${posted.url}` : ""}`;
			},
		};
	}

	if (item.action === "annotate") {
		if (!conversation.commentOn) {
			return `The ${bound.provider.id} provider cannot start a thread on a line. Compose it with review_draft instead.`;
		}
		if (!item.path || item.line === undefined) {
			return `${address}: starting a thread needs a path and a line.`;
		}
		if (!item.body) return `${address}: a remark needs a body.`;
		const anchor: Anchor = {
			subject: "line",
			path: item.path,
			line: item.line,
			...(item.startLine === undefined ? {} : { startLine: item.startLine }),
			blob: item.side ?? "new",
		};
		const body = item.body;
		const commentOn = conversation.commentOn;
		return {
			item,
			address,
			panel: {
				destination,
				where: anchorLabel(anchor),
				payload: { body },
			},
			perform: async () => {
				const posted = await commentOn(change, anchor, body);
				return `${GLYPH.lands} remarked on ${address}${posted.url ? `\n   ${posted.url}` : ""}`;
			},
		};
	}

	if (item.action === "react") {
		if (!item.reaction || !item.comment) {
			return `${address}: reacting needs a reaction and the comment to put it on, addressed as the [C#] or [M#] a listing prints.`;
		}
		if (!conversation.react) {
			return `The ${bound.provider.id} provider does not support reactions.`;
		}
		const allowed = bound.capabilities.conversation?.reactions ?? [];
		if (!allowed.includes(item.reaction as Reaction)) {
			return allowed.length > 0
				? `That provider accepts ${allowed.join(", ")}.`
				: "That provider accepts no reactions.";
		}
		const found = await findReactableOn(bound, item.comment);
		if (isReactableRefusal(found)) return found.reason;
		const reaction = item.reaction as Reaction;
		const react = conversation.react;
		return {
			item,
			address,
			// The gate quotes the remark, since an address is not something a
			// person can check: [C4] approved against the wrong comment is
			// indistinguishable from [C4] approved against the right one.
			panel: {
				destination,
				context: [
					{
						who: `${found.label} ${found.message.author.id}`,
						body: found.message.body,
					},
				],
				consequence: [`${GLYPH.reaction} ${reaction}`],
			},
			perform: async () => {
				await react(change, found.message, reaction);
				return `${GLYPH.reaction} reacted to ${found.label}.`;
			},
		};
	}

	const thread = threads[(item.thread ?? 0) - 1];
	if (!thread) {
		return `There is no [T${item.thread ?? "?"}] on this change. Read the threads first; the listing numbers them.`;
	}

	if (item.action === "resolve" || item.action === "unresolve") {
		const reopening = item.action === "unresolve";
		if (reopening && !conversation.unresolve) {
			return `The ${bound.provider.id} provider cannot reopen a resolved thread.`;
		}
		return {
			item,
			address,
			// The whole exchange and no payload: what is being approved is the
			// judgement that it is finished, so the exchange is the question.
			panel: {
				destination,
				where: threadWhere(thread),
				context: exchange(thread),
			},
			perform: async () => {
				if (reopening) await conversation.unresolve?.(change, thread);
				else await conversation.resolve(change, thread);
				return `${reopening ? GLYPH.unresolved : GLYPH.resolved} ${reopening ? "reopened" : "resolved"} ${address}.`;
			},
		};
	}

	if (item.action !== "reply") {
		return `${address}: ${item.action} is not something review_say can do.`;
	}
	if (!item.body) return `${address}: a reply needs a body.`;

	const settle = item.settleThread;
	const cannot = settleRefusal(conversation, settle, bound.provider.id);
	if (cannot) return cannot;
	const body = item.body;

	return {
		item,
		address,
		panel: {
			destination,
			where: threadWhere(thread),
			context: exchange(thread),
			payload: { as: "replying", body },
			// Printed either way, so silence never has to be read as a
			// decision somebody made.
			consequence: [settleLine(settle)],
		},
		perform: async () => {
			const posted = await conversation.reply(change, thread, body);
			const after = await settleAfter(conversation, change, thread, settle);
			return [
				`${GLYPH.lands} replied to ${address}${posted.url ? `\n   ${posted.url}` : ""}`,
				...(after.note
					? [`${after.settled ? GLYPH.resolved : GLYPH.refused} ${after.note}`]
					: []),
			].join("\n");
		},
	};
}

/** Where a thread hangs, and how it stands, for a gate to show. */
function threadWhere(thread: Thread): string {
	const where = thread.anchor
		? anchorLabel(thread.anchor)
		: "on the change itself";
	const replies = thread.comments.length - 1;
	return [
		where,
		thread.resolved ? "resolved" : "open",
		...(replies > 0 ? [count(replies, "reply", "replies")] : []),
		...(thread.stale ? ["stale"] : []),
	].join(" \u00b7 ");
}

/**
 * The exchange so far, for the gate to quote.
 *
 * What is being answered is as much a part of the decision as what is
 * being said. This surface learned that once already, on the react gate,
 * and did not carry it across.
 */
function exchange(thread: Thread): GateQuote[] {
	return thread.comments.map((one) => ({
		who: one.author.id,
		body: one.body,
	}));
}

/** What the gate says will become of the thread, said out loud either way. */
function settleLine(settle: Settle | undefined): string {
	if (settle === "resolve") {
		return `${GLYPH.resolved} then resolves the thread`;
	}
	if (settle === "unresolve") {
		return `${GLYPH.unresolved} then reopens the thread`;
	}
	return `${GLYPH.unresolved} leaves the thread as it is`;
}
