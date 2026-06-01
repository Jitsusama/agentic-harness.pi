/**
 * Prose convention detection: finds the mechanically certain
 * violations of the writing voice (emdashes and non-Canadian
 * spelling) so a guardian can block and point the author at the
 * skill. Detection never rewrites; it names what is wrong and
 * leaves the nuanced repair to the author.
 */

/** A single prose convention violation. */
export interface ProseViolation {
	/** Which rule was broken. */
	readonly kind: "emdash" | "spelling" | "curly-quote" | "ellipsis";
	/** The offending text as it appears. */
	readonly found: string;
	/** The Canadian replacement, when there is a single right one. */
	readonly suggestion?: string;
	/** A short statement of the rule, for the block message. */
	readonly rule: string;
}

const EMDASH_RULE =
	"prose-standard: never use emdashes; restructure the sentence (a colon, semi-colon, parentheses or a new sentence).";
const SPELLING_RULE =
	"prose-standard: use Canadian English spelling exclusively.";
const CURLY_QUOTE_RULE = "prose-standard: use straight quotes, not curly ones.";
const ELLIPSIS_RULE =
	"prose-standard: spell out an ellipsis as three periods, not the Unicode character.";

/**
 * Curated American/British to Canadian spelling pairs. This is a
 * deliberate allowlist, not a rule. A rule-based `-ize`/`-ise`
 * or `-or`/`-our` check produces a flood of false positives
 * (`size`, `noise`, `surprise`, `otherwise`, `doctor`,
 * `anchor`), so each pair here is one we are certain about. The
 * key is the form to flag; the value is the Canadian form.
 *
 * This list is the enforced half of a bound pair: the prose-standard
 * skill carries the same table for a human to read, and
 * tests/lib/prose/spelling-binding.test.ts asserts the two are
 * identical, so neither can drift from the other. To change what
 * the gate flags, change the skill and this list together.
 *
 * Meaning-dependent words are deliberately excluded so the gate
 * never flags a correct spelling: `licence`/`license`,
 * `practice`/`practise` and `cheque`/`check` turn on part of
 * speech or sense; `meter` (the instrument) is correct while
 * `metre` (the unit) is not; `aluminum`, `program` and `dialog`
 * (the UI element) are the spellings Canadian English keeps. A
 * miss is a missed block, never a wrong rewrite.
 *
 * Stored lowercase; matching is case-insensitive and the
 * suggestion preserves the original's leading-capital shape.
 */
export const SPELLING_PAIRS: ReadonlyArray<readonly [string, string]> = [
	// -our (American -or)
	["color", "colour"],
	["colors", "colours"],
	["colored", "coloured"],
	["behavior", "behaviour"],
	["behaviors", "behaviours"],
	["honor", "honour"],
	["honored", "honoured"],
	["favor", "favour"],
	["favored", "favoured"],
	["favorite", "favourite"],
	["favorites", "favourites"],
	["neighbor", "neighbour"],
	["neighbors", "neighbours"],
	["labor", "labour"],
	["flavor", "flavour"],
	["flavors", "flavours"],
	["valor", "valour"],
	["vapor", "vapour"],
	["rumor", "rumour"],
	["humor", "humour"],
	["harbor", "harbour"],
	["armor", "armour"],
	["endeavor", "endeavour"],
	["savior", "saviour"],
	// -re (American -er)
	["center", "centre"],
	["centers", "centres"],
	["centered", "centred"],
	["theater", "theatre"],
	["theaters", "theatres"],
	["fiber", "fibre"],
	["fibers", "fibres"],
	["liter", "litre"],
	["liters", "litres"],
	// -ce noun (American -se)
	["defense", "defence"],
	["defenses", "defences"],
	["offense", "offence"],
	["offenses", "offences"],
	// -ize (British -ise; Canadian keeps -ize like American)
	["organise", "organize"],
	["organised", "organized"],
	["organising", "organizing"],
	["recognise", "recognize"],
	["recognised", "recognized"],
	["summarise", "summarize"],
	["summarised", "summarized"],
	["analyse", "analyze"],
	["analysed", "analyzed"],
	["prioritise", "prioritize"],
	["prioritised", "prioritized"],
	["realise", "realize"],
	["realised", "realized"],
	["minimise", "minimize"],
	["maximise", "maximize"],
	["optimise", "optimize"],
	["initialise", "initialize"],
	["initialised", "initialized"],
	["standardise", "standardize"],
	["customise", "customize"],
	["generalise", "generalize"],
	["specialise", "specialize"],
	["normalise", "normalize"],
	["serialise", "serialize"],
	["synchronise", "synchronize"],
	// doubled consonant before a suffix (Canadian doubles the l)
	["traveler", "traveller"],
	["traveled", "travelled"],
	["traveling", "travelling"],
	["canceled", "cancelled"],
	["canceling", "cancelling"],
	["modeling", "modelling"],
	["modeled", "modelled"],
	["labeling", "labelling"],
	["labeled", "labelled"],
	["fueled", "fuelled"],
	// -ogue (American -og)
	["catalog", "catalogue"],
	["catalogs", "catalogues"],
	// grey (American gray)
	["gray", "grey"],
	["grays", "greys"],
	// single l (American doubles)
	["enroll", "enrol"],
	["enrollment", "enrolment"],
	["fulfill", "fulfil"],
	["fulfillment", "fulfilment"],
];

/** Build the case-insensitive, whole-word spelling regex once. */
const SPELLING_LOOKUP = new Map(SPELLING_PAIRS);
const SPELLING_REGEX = new RegExp(
	`\\b(${SPELLING_PAIRS.map(([from]) => from).join("|")})\\b`,
	"gi",
);

const EMDASH_REGEX = /\u2014/g;
// The literal six-character escape an author types when they
// meant an emdash. prose-standard bans it as an emdash in
// disguise, so it is reported under the same kind.
const EMDASH_ESCAPE_REGEX = /\\u2014/gi;
const CURLY_QUOTE_REGEX = /[\u2018\u2019\u201C\u201D]/g;
const ELLIPSIS_REGEX = /\u2026/g;
const FENCE_REGEX = /```[\s\S]*?```/g;

/** Map a curly quote to its straight ASCII equivalent. */
const STRAIGHT_QUOTE: Readonly<Record<string, string>> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201C": '"',
	"\u201D": '"',
};
const INLINE_CODE_REGEX = /`[^`\n]*`/g;
const URL_REGEX = /https?:\/\/\S+/g;
// Deliberately conservative: only tokens that clearly open as a
// path or home reference (`~/`, `./`, `/`) are masked. Masking
// every slash-joined token would eat ordinary prose like
// "and/or" and "3/4" and could swallow a real spelling violation
// that follows. A bare relative path that slips through is
// almost always backticked anyway, and the worst case is a false
// block the author clears by wrapping the path in backticks.
const PATH_REGEX = /(?:^|\s)[~./][\w./-]*\/[\w./-]+/g;

/**
 * Replace every match of a pattern with spaces of the same
 * length, so later offset-based scans see blanks where the
 * non-prose region was without the surrounding text shifting.
 */
function blankOut(text: string, pattern: RegExp): string {
	return text.replace(pattern, (match) => " ".repeat(match.length));
}

/** Preserve the original's leading-capital shape on a suggestion. */
function matchCase(found: string, suggestion: string): string {
	if (found[0] && found[0] === found[0].toUpperCase()) {
		return suggestion[0].toUpperCase() + suggestion.slice(1);
	}
	return suggestion;
}

/**
 * Find every emdash and non-Canadian spelling in prose, skipping
 * regions where the text is not prose (code fences, inline code,
 * URLs, paths).
 */
export function detectProseViolations(text: string): ProseViolation[] {
	// Mask non-prose regions first so their contents never match.
	let prose = blankOut(text, FENCE_REGEX);
	prose = blankOut(prose, INLINE_CODE_REGEX);
	prose = blankOut(prose, URL_REGEX);
	prose = blankOut(prose, PATH_REGEX);

	const violations: ProseViolation[] = [];

	for (const match of prose.matchAll(EMDASH_REGEX)) {
		violations.push({ kind: "emdash", found: match[0], rule: EMDASH_RULE });
	}

	for (const match of prose.matchAll(EMDASH_ESCAPE_REGEX)) {
		violations.push({ kind: "emdash", found: match[0], rule: EMDASH_RULE });
	}

	for (const match of prose.matchAll(CURLY_QUOTE_REGEX)) {
		violations.push({
			kind: "curly-quote",
			found: match[0],
			suggestion: STRAIGHT_QUOTE[match[0]],
			rule: CURLY_QUOTE_RULE,
		});
	}

	for (const match of prose.matchAll(ELLIPSIS_REGEX)) {
		violations.push({
			kind: "ellipsis",
			found: match[0],
			suggestion: "...",
			rule: ELLIPSIS_RULE,
		});
	}

	for (const match of prose.matchAll(SPELLING_REGEX)) {
		const found = match[0];
		const canadian = SPELLING_LOOKUP.get(found.toLowerCase());
		if (!canadian) continue;
		violations.push({
			kind: "spelling",
			found,
			suggestion: matchCase(found, canadian),
			rule: SPELLING_RULE,
		});
	}

	return violations;
}
