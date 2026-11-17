/**
 * Whether an orchestrator's pivot, question or spawn note narrows the
 * verdict of something done in the person's name without saying whose
 * word the limit is.
 *
 * On 16 November at 22:26 the person said of a review "I want it
 * posted", and the orchestrator told the review cell "Post no approval
 * or block that Joel didn't ask for: a comment review." He had asked
 * for no such limit, and at 22:29 asked why it was there. A filed rule
 * didn't stop the next one; this does. A sentence that limits a
 * verdict (approve, request changes, block, comment-only) goes only
 * when it cites its source: his words quoted just after his name, a
 * message's id, a standing rule on something, a document or a skill by
 * its name, or an owner's ruling by address.
 *
 * The rule was narrowed by replaying a day of one orchestrator's pivots,
 * questions and spawn notes, and every orchestrator's spawn notes, 287
 * in all. Refusing any unsourced limit on an act refused 52, nearly all
 * sound: hardware and network safety, owners' fences, descriptions. So
 * limits on anything but a verdict are left alone, as are a ban on
 * publishing outright and a review kept a draft, both his standing
 * rule, and questions, which order nothing. The rule refuses 2 of the
 * 287: the 22:26 sentence, and one sound one that limited a verdict
 * without naming why.
 */

/** A session's address, as an owner's ruling names it. */
const ADDRESS = String.raw`\b[0-9A-Z]{6}\b`;

/**
 * A limit opening a clause: after a stop or a dash, or after a word that
 * makes it an order ("Post no", "must never") rather than a fact ("is
 * no", "if nothing"). Every one in a sentence is read, so a limit of its
 * own ahead of it hides none.
 */
const LIMIT =
	/(?:^|[,;:(\u2014\u2013]\s*|\s-\s+|(?<![\w'\u2019])(?!(?:is|was|are|were|has|have|had|of|in|for|there|if|when|whether|unless|that)\b)\w+\s+)(never|don['\u2019]?t|do not|not|nothing but|no|nothing|none|only|at most|except|without|avoid|withhold)\b/gi;

/** A verdict said before the limit that bounds it: "Comment review only", "Approval: none". */
const TRAILING = /^(only|none)$/i;

/** Whose approval a limit waits on, which narrows no verdict of his. */
const WHOSE = String.raw`(?<!\b\w+['\u2019]s\s+|\b(?:his|my|our|your|their)\s+)`;

/**
 * A verdict on a change, the person's to narrow. "Block" only as one
 * ("block it", "or block"), not "block a restart" or "block other
 * sessions".
 */
const VERDICT = new RegExp(
	[
		`${WHOSE}approv\\w*`,
		"request(ing)? changes",
		"comment[- ]only",
		"comment review",
		"verdicts?",
		"blocking (review|verdict|comments?)",
		// "Post only a comment", "a comment only": a comment as the whole verdict.
		"\\b(a|one|just a) comment(?=\\s*$)",
		String.raw`block(s|ed)?(?=\s*$|\s+(that|which|it|this|the (pr|change|review))\b)`,
	].join("|"),
	"i",
);

/** A verdict word told of rather than ordered: "no blocking comments remain". */
const TOLD_OF =
	/^\W*(\w+\s+)?(remains?|is|are|was|were|left|exists?|stands?|limits?|rules?|needed|needs?|required|necessary|yet)\b(?!\s+to\b)/i;

/**
 * What the limit waives or tells of rather than forbids: "no need to
 * re-approve", "it only needs an approval".
 */
const WAIVER = /^(need|needs|needed|reason|one needs)\b/i;

/** A verdict waited on, not ordered: "no restart without approval". */
const WAITED_ON =
	/\b(without|until|till|after|pending|awaiting|before|for|on)\s+(\w+\s+)?$/i;

/**
 * A condition on a verdict, which keeps review hygiene ("never approve a
 * PR with failing CI") rather than narrowing what he decided.
 */
const CONDITION =
	/\b(if|with|without|before|unless|until|till|when|while|once|after)\b|\b(your|its|their) own\b/i;

/** Publishing, which a limit may ban outright by the person's drafts rule. */
const PUBLISHING =
	/^(post(s|ed|ing)?|publish\w*|send|sent|comment(s|ing)? live)\b/i;

/** A review kept a draft, for the person to publish; not a draft pull request. */
const DRAFTS =
	/\b(as|a|in|only) drafts?\b(?! (pr|pull|change)s?\b)|\bdrafts only\b|\bdraft (it|the review|a review)\b|for (joel|him) to (publish|post|send)|(his|joel'?s) to (publish|post|send)/i;

/** A draft said not to be one, which keeps nothing a draft. */
const NOT_A_DRAFT = /\bnot a draft\b/i;

/** His words quoted, as the sentence says they are his just before them. */
const HIS_QUOTE =
	/\b(joel|he|the person)\b[^"\u201c.]{0,25}?(said|asked|wrote|:)[^"\u201c]{0,6}["\u201c][^"\u201d]{12,}["\u201d]/i;

/** Words quoted anywhere, which are mentioned there, not ordered. */
const QUOTED = /["\u201c][^"\u201d]*["\u201d]/g;

/** A message's id, as the mesh shows it. */
const MESSAGE_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/;

/** A named standing rule, document or skill. */
const NAMED_RULE =
	/\b((standing|his|joel['\u2019]?s) (standing )?(rule|gate)s? (on|of|about|for) \w+|AGENTS\.md|docs\/\S+|[a-z]+(-[a-z]+)+ skill)\b/i;

/** An owner's ruling, by address. */
const RULING = new RegExp(
	[
		`${ADDRESS}(?:'s)? (says|said|answers|decides|owns|keeps|holds|agrees|rules)`,
		`(until|unless|till|before) ${ADDRESS}`,
		`${ADDRESS}'s (call|say|word|yes|domain|lane|fence)`,
	].join("|"),
);

/** The sentences of a message, its links left out. */
function sentences(text: string): string[] {
	return text
		.replace(/https?:\/\/\S+/g, "URL")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((part) =>
			part
				.trim()
				// Emphasis hides no limit word.
				.replace(/\*+|(?<!\w)_+|_+(?!\w)/g, "")
				.replace(/^[\s\-\d.)]*/, "")
				.replace(/[\s-]+$/, ""),
		)
		.filter(Boolean);
}

/** What a limit covers, split at commas, "or" and "and", up to its clause's end. */
function covered(rest: string): string[] {
	const clause =
		rest.split(/[:;.\u2014\u2013]|\s-\s|\b(?:so|because|since|but)\b/)[0] ?? "";
	return clause
		.split(/,|\bor\b|\band\b|\bnor\b/)
		.map((one) => one.trim())
		.filter(Boolean);
}

/** Whether a sentence says whose word its limit is. */
function sourced(sentence: string): boolean {
	return [HIS_QUOTE, MESSAGE_ID, NAMED_RULE, RULING].some((source) =>
		source.test(sentence),
	);
}

/** Whether one item a limit covers is a verdict ordered, not told of. */
function verdictOrdered(item: string): boolean {
	if (WAIVER.test(item)) return false;
	const verdict = VERDICT.exec(item);
	if (!verdict) return false;
	if (WAITED_ON.test(item.slice(0, verdict.index))) return false;
	const after = item.slice(verdict.index + verdict[0].length);
	return !TOLD_OF.test(after) && !CONDITION.test(after);
}

/** Whether a limit's items narrow a verdict, rather than ban publishing outright. */
function narrowed(items: string[]): boolean {
	const outright = items.some(
		(item) => PUBLISHING.test(item) && !VERDICT.test(item),
	);
	return !outright && items.some(verdictOrdered);
}

/**
 * Whether a sentence asks rather than orders: a tag such as ", OK?", or
 * a polite order ("Could you post it with no approval?"), asks nothing.
 */
function asks(sentence: string): boolean {
	return (
		sentence.endsWith("?") &&
		!/,\s*[\w ]{1,12}\?$/i.test(sentence) &&
		!/^(please |so )?(could|can|would|will) you\b/i.test(sentence)
	);
}

/** What's posted, just before a "without" that limits its verdict. */
const POSTED_BEFORE =
	/\b(post|publish|send|submit|review|leave)\w*(\s+\w+){0,3}\s+without$/i;

/** A clause telling how things stand, whose trailing "only" orders nothing. */
const STATE = /\b(is|are|was|were|be|been|remains?|stays?)\b/i;

/** A comment-only verdict named as the whole of it: "keep it comment-only". */
const COMMENT_ONLY = /\bcomment[- ]only\b/i;

/** The clause a trailing limit bounds: the words before it, back to a stop. */
function before(sentence: string, at: number): string[] {
	const clause =
		sentence
			.slice(0, at)
			.split(/[,;.\u2014\u2013]/)
			.pop() ?? "";
	return [clause.replace(/:\s*$/, "").trim()].filter(Boolean);
}

/** Whether a sentence narrows a verdict with no source and no drafts rule behind it. */
function narrowsVerdict(sentence: string): boolean {
	if (asks(sentence) || sourced(sentence)) return false;
	if (DRAFTS.test(sentence) && !NOT_A_DRAFT.test(sentence)) return false;
	// What is quoted is named, not ordered: "drop my 'comment review only'".
	const said = sentence.replace(QUOTED, (quote) => " ".repeat(quote.length));
	const commentOnly = COMMENT_ONLY.exec(said);
	if (
		commentOnly &&
		verdictOrdered(said.slice(commentOnly.index)) &&
		!TOLD_OF.test(
			said.slice(0, commentOnly.index).split(/\s+/).slice(-2).join(" "),
		)
	) {
		return true;
	}
	return [...said.matchAll(LIMIT)].some((limit) => {
		const at = limit.index ?? 0;
		const word = limit[1] ?? "";
		// "Without" limits a verdict only on what's posted: "post it
		// without approval", not "no restart without approval".
		if (
			/^without$/i.test(word) &&
			!POSTED_BEFORE.test(said.slice(0, at + limit[0].length))
		) {
			return false;
		}
		const rest = said.slice(at + limit[0].length);
		// "Approve it only if CI is green" keeps hygiene.
		const bounded =
			TRAILING.test(word) && !CONDITION.test(rest.split(/[,;.]/)[0] ?? "")
				? before(said, at + limit[0].length - word.length)
				: [];
		return (
			narrowed(covered(said.slice(at + limit[0].length))) ||
			// "Is blocked only by one finding" tells of it.
			bounded.some((clause) => verdictOrdered(clause) && !STATE.test(clause))
		);
	});
}

/**
 * Why an orchestrator's message can't go as written, when a sentence
 * narrows the verdict of something done in the person's name and cites
 * no source; undefined when it may go.
 */
export function limitsRefusal(text: string): string | undefined {
	const unasked = sentences(text).find(narrowsVerdict);
	if (unasked === undefined) return undefined;
	return `this limits a verdict the person didn't ask to limit ("${unasked}"). A limit on what's approved, blocked or left a comment is his to set: quote his words and say they are his, give the id of the message it comes from, name the standing rule or document, or the owner whose ruling it is by address; or take the limit out.`;
}
