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
 * when it cites its source: his words quoted, a message's id, a named
 * rule, skill or document, or an owner's ruling ("until LWKYKQ says").
 *
 * The rule was narrowed by replaying a day of one orchestrator's pivots,
 * questions and spawn notes, and every orchestrator's spawn notes, 287
 * in all. Refusing any unsourced limit on an act refused 52, nearly all
 * sound: hardware and network safety, owners' fences, descriptions. So
 * limits on anything but a verdict are left alone, as are a ban on
 * publishing outright and a review kept a draft, both his standing
 * rule. The narrowed rule refuses 2 of the 287: the 22:26 sentence, and
 * one sound one that limited a verdict without naming why.
 */

/** A session's address, as an owner's ruling names it. */
const ADDRESS = String.raw`\b[0-9A-Z]{6}\b`;

/**
 * A limit opening a clause: after a stop, or after a word that makes it
 * an order ("Post no", "must never") rather than a fact ("is no",
 * "if nothing").
 */
const LIMIT =
	/(?:^|[,;:(]\s*|\b(?!(?:is|was|are|were|has|have|had|with|of|in|for|there|if|when|whether|unless|that)\b)\w+\s+)(never|don'?t|do not|no|nothing|none|only|at most|except|without)\b(.*)$/i;

/** A verdict on a change, the person's to narrow. "Block" alone, not "block a restart". */
const VERDICT =
	/\b(approv\w*|request(ing)? changes|comment[- ]only|comment review|verdicts?|block(ing|s)?\b(?! (a|an|the|any|on|for|until|it|them|this)\b))/i;

/** Publishing, which a limit may ban outright by the person's drafts rule. */
const PUBLISHING =
	/^(post(s|ed|ing)?|publish\w*|send|sent|merg\w*|push|comment(s|ing)? live)\b/i;

/** A review kept a draft, for the person to publish. */
const DRAFTS =
	/\bdrafts?\b|\blive\b|for (joel|him) to (publish|post|send)|(his|joel'?s) to (publish|post|send)/i;

/** A draft said not to be one, which keeps nothing a draft. */
const NOT_A_DRAFT = /\bnot a draft\b/i;

/** His words, quoted. */
const QUOTE = /["\u201c]([^"\u201d]{12,})["\u201d]/;

/** A message's id, as the mesh shows it. */
const MESSAGE_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/;

/** A named rule, skill or document. */
const NAMED_RULE =
	/\b(standing( rules?)?|his (rule|gate|word|ask)s?|joel'?s (rule|gate|word|ask)s?|as (he|joel) (said|asked|set)|he (said|asked|set)|AGENTS\.md|docs\/\S+|skill|convention|rules? \w+|policy|the map|README)\b/i;

/** An owner's ruling, by address. */
const RULING = new RegExp(
	[
		`${ADDRESS}(?:'s)? (says|said|answers|decides|owns|keeps|holds|agrees|rules)`,
		`(until|unless|till|before) ${ADDRESS}`,
		`${ADDRESS}'s (call|say|word|yes|domain|lane|fence)`,
		`(to|through|from|ask|tell|with) ${ADDRESS}`,
	].join("|"),
);

/** A sentence's opening label, such as "Scope:" or "**Next:**". */
const LABEL = /^[\s\-*\d.)]*(\*\*)?[A-Z][\w ]{0,20}:(\*\*)?\s+/;

/** The sentences of a message, its links and the harness's notes left out. */
function sentences(text: string): string[] {
	return text
		.replace(/\[Automated message[^\]]*\]/g, "")
		.replace(/https?:\/\/\S+/g, "URL")
		.split(/(?<=[.!?])\s+|\n+/)
		.map((part) =>
			part
				.trim()
				.replace(LABEL, "")
				.replace(/^[\s\-*]+|[\s\-*]+$/g, ""),
		)
		.filter(Boolean);
}

/** What a limit covers, split at commas, "or" and "and", up to its clause's end. */
function covered(rest: string): string[] {
	const clause =
		rest.split(
			/[:;.]|\b(?:so|because|since|until|unless|but|while|when)\b/,
		)[0] ?? "";
	return clause
		.split(/,|\bor\b|\band\b|\bnor\b/)
		.map((one) => one.trim())
		.filter(Boolean);
}

/** Whether a sentence says whose word its limit is. */
function sourced(sentence: string): boolean {
	return [QUOTE, MESSAGE_ID, NAMED_RULE, RULING].some((source) =>
		source.test(sentence),
	);
}

/** Whether a sentence narrows a verdict with no source and no drafts rule behind it. */
function narrowsVerdict(sentence: string): boolean {
	if (sourced(sentence)) return false;
	if (DRAFTS.test(sentence) && !NOT_A_DRAFT.test(sentence)) return false;
	const limit = LIMIT.exec(sentence);
	if (!limit) return false;
	const items = covered(limit[2] ?? "");
	return (
		items.some((item) => VERDICT.test(item)) &&
		!items.some((item) => PUBLISHING.test(item))
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
	return `this limits a verdict the person didn't ask to limit ("${unasked}"). A limit on what's approved, blocked or left a comment is his to set: quote his words, name the message or rule it comes from, or the owner whose ruling it is (until LWKYKQ says so), or take the limit out.`;
}
