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
	readonly kind: "emdash" | "spelling";
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

/**
 * Curated American/British to Canadian spelling pairs. This is a
 * deliberate allowlist, not a rule. A rule-based `-ize`/`-ise`
 * or `-or`/`-our` check produces a flood of false positives
 * (`size`, `noise`, `surprise`, `otherwise`, `doctor`,
 * `anchor`), so each pair here is one we are certain about. The
 * key is the form to flag; the value is the Canadian form.
 *
 * Stored lowercase; matching is case-insensitive and the
 * suggestion preserves the original's leading-capital shape.
 */
const SPELLING_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["color", "colour"],
	["colors", "colours"],
	["behavior", "behaviour"],
	["behaviors", "behaviours"],
	["honor", "honour"],
	["favor", "favour"],
	["favorite", "favourite"],
	["neighbor", "neighbour"],
	["labor", "labour"],
	["flavor", "flavour"],
	["center", "centre"],
	["centers", "centres"],
	["meter", "metre"],
	["theater", "theatre"],
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
];

/** Build the case-insensitive, whole-word spelling regex once. */
const SPELLING_LOOKUP = new Map(SPELLING_PAIRS);
const SPELLING_REGEX = new RegExp(
	`\\b(${SPELLING_PAIRS.map(([from]) => from).join("|")})\\b`,
	"gi",
);

const EMDASH_REGEX = /\u2014/g;
const FENCE_REGEX = /```[\s\S]*?```/g;
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
