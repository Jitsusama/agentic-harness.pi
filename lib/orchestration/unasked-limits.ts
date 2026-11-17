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
 * when it cites its source: his words quoted with his name, a
 * message's id, a named standing rule, document or skill, or an
 * owner's ruling by address.
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
	/(?:^|[,;:(\u2014\u2013]\s*|\s-\s+|(?<![\w'\u2019])(?!(?:is|was|are|were|has|have|had|of|in|for|there|if|when|whether|unless|that)\b)\w+\s+)(never|don['\u2019]?t|do not|not|no|nothing|none|only|at most|except|without)\b/gi;

/** Whose approval a limit waits on, which narrows no verdict of his. */
const WHOSE = String.raw`(?<!\b(?:joel|person|owner)['\u2019]?s\s+|\b(?:his|your|their)\s+)`;

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
		String.raw`blocking (review|verdict|comments?)`,
		String.raw`block(s|ed)?(?=\s*$|\s+(that|which|it|this|the (pr|change|review)|on (it|the (pr|change)))\b)`,
	].join("|"),
	"i",
);

/** A verdict word told of rather than ordered: "no blocking comments remain". */
const TOLD_OF =
	/\b(remains?|is|are|was|were|left|exists?|stands?|limits?|rules?)\b/i;

/** Publishing, which a limit may ban outright by the person's drafts rule. */
const PUBLISHING =
	/^(post(s|ed|ing)?|publish\w*|send|sent|merg\w*|push|comment(s|ing)? live)\b/i;

/** A review kept a draft, for the person to publish. */
const DRAFTS =
	/\bdrafts?\b|for (joel|him) to (publish|post|send)|(his|joel'?s) to (publish|post|send)/i;

/** A draft said not to be one, which keeps nothing a draft. */
const NOT_A_DRAFT = /\bnot a draft\b/i;

/** Words quoted, which are his only when the sentence says so. */
const QUOTE = /["\u201c]([^"\u201d]{12,})["\u201d]/;

/** The person, named where his words are quoted. */
const HIM = /\b(joel|he|his|him|the person)\b/i;

/** A message's id, as the mesh shows it. */
const MESSAGE_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/;

/** A named standing rule, document or skill. */
const NAMED_RULE =
	/\b(standing rules?|his (rule|gate)s?|joel['\u2019]?s (rule|gate)s?|AGENTS\.md|docs\/\S+|[a-z]+(-[a-z]+)+ skill)\b/i;

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
				.replace(/^[\s\-*\d.)]*(\*\*)?/, "")
				.replace(/[\s\-*]+$/, ""),
		)
		.filter(Boolean);
}

/** What a limit covers, split at commas, "or" and "and", up to its clause's end. */
function covered(rest: string): string[] {
	const clause =
		rest.split(
			/[:;.\u2014\u2013]|\s-\s|\b(?:so|because|since|until|unless|but|while|when)\b/,
		)[0] ?? "";
	return clause
		.split(/,|\bor\b|\band\b|\bnor\b/)
		.map((one) => one.trim())
		.filter(Boolean);
}

/** Whether a sentence says whose word its limit is. */
function sourced(sentence: string): boolean {
	return (
		(QUOTE.test(sentence) && HIM.test(sentence)) ||
		[MESSAGE_ID, NAMED_RULE, RULING].some((source) => source.test(sentence))
	);
}

/** Whether one item a limit covers is a verdict ordered, not told of. */
function verdictOrdered(item: string): boolean {
	const verdict = VERDICT.exec(item);
	if (!verdict) return false;
	return !TOLD_OF.test(item.slice(verdict.index + verdict[0].length));
}

/** Whether a limit's items narrow a verdict, rather than ban publishing outright. */
function narrowed(items: string[]): boolean {
	const outright = items.some(
		(item) => PUBLISHING.test(item) && !VERDICT.test(item),
	);
	return !outright && items.some(verdictOrdered);
}

/** Whether a sentence narrows a verdict with no source and no drafts rule behind it. */
function narrowsVerdict(sentence: string): boolean {
	if (sentence.endsWith("?") || sourced(sentence)) return false;
	if (DRAFTS.test(sentence) && !NOT_A_DRAFT.test(sentence)) return false;
	return [...sentence.matchAll(LIMIT)].some((limit) =>
		narrowed(covered(sentence.slice((limit.index ?? 0) + limit[0].length))),
	);
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
