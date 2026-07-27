/**
 * Asking a stored payload a question.
 *
 * One query language for every tool that stores anything, because
 * the cost of a query language is learning it, and that cost is
 * paid once only if the language does not change per family.
 * JSONPath is the choice: a language model already knows it, and
 * filters mean a caller can find the records they want rather
 * than paging through records they do not.
 *
 * Every answer is bounded twice. At most a fixed number of
 * matches are serialized, and the serialized text passes back
 * through the same size rule that sent the payload to disk in the
 * first place, so a query broad enough to select everything
 * cannot undo the storing. The total match count is always
 * reported before that truncation, which means a deliberately
 * broad expression is the cheapest way to answer "how many"
 * without pulling a single whole record.
 *
 * The second of those bounds was documented here and never
 * written, which is the worst of both: `$.rows[*]` over a stored
 * listing came back larger than the payload the store had just
 * taken out of context, and the sentence above said it could not.
 *
 * Nothing here throws. A handle that has expired, a payload that
 * no longer parses and an expression with a typo are all ordinary
 * events in a conversation, and each comes back as a note that
 * says what to do differently.
 */

import { JSONPath } from "jsonpath-plus";
import { cite } from "./cite.js";
import { LISTING_BUDGET_BYTES } from "./listing.js";
import { HandleExpiredError, type ResultStore } from "./store.js";
import { withinLineBudget } from "./view.js";

/** A block of text an answer is made of. */
export interface TextBlock {
	readonly type: "text";
	readonly text: string;
}

/** Bounds on a query's answer. */
export interface QueryOptions {
	/** Cap on the serialized answer, above which it is stored instead. */
	limitBytes?: number;
	/** Cap on how many matches are serialized. */
	maxMatches?: number;
}

/** How many matches an answer carries when the caller says nothing. */
export const DEFAULT_MAX_MATCHES = 100;

/**
 * How many bytes an answer spends before it is stored instead.
 *
 * The same figure a rendered listing spends, because it is the
 * same question: how much of a collection goes in front of the
 * model before the rest is put where it can be asked about. This
 * was 256 KB while nothing enforced it, which is roughly sixty
 * thousand tokens and so not a bound anybody would have wanted;
 * no behaviour depended on the old number, since no code read it.
 */
export const DEFAULT_ANSWER_BYTES = LISTING_BUDGET_BYTES;

/** How much of a caller's own string is echoed back in a note. */
const MAX_EXPRESSION_ECHO = 200;

/** What a query did, for a caller that wants to store the answer. */
export interface QueryAnswer {
	readonly blocks: readonly TextBlock[];
	/** Total matches before any cap, when the expression ran at all. */
	readonly matches?: number;
	/** The serialized matches, whatever their size. */
	readonly json?: string;
}

/**
 * Run a JSONPath expression against a stored payload.
 *
 * The answer opens with the total match count, so the number is
 * never a casualty of the cap that follows it.
 */
export function queryStored(
	store: ResultStore,
	handle: string,
	expression: string,
	opts: QueryOptions = {},
): QueryAnswer {
	let rawText: string;
	try {
		rawText = store.read(handle);
	} catch (err) {
		if (err instanceof HandleExpiredError) return note(err.message);
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return note(`stored result for handle ${handle} is not valid JSON`);
	}

	let matches: unknown[];
	try {
		matches = JSONPath({
			path: expression,
			json: parsed as string | number | boolean | object | null,
			wrap: true,
			// Filter expressions are the most useful verb in the language,
			// so evaluation stays on. The expression comes from a model
			// that can already run anything through bash, so this grants no
			// capability it lacked; the catch below is about a typo, not a
			// boundary.
			eval: true,
		}) as unknown[];
	} catch (err) {
		return note(
			`invalid JSONPath expression: ${err instanceof Error ? err.message : String(err)}. ` +
				"If a field name contains dots it is a single literal key, so match " +
				"it with bracket notation like @['a.b.c'] rather than dot access.",
		);
	}

	if (matches.length === 0)
		return note(
			`no matches for expression ${echo(expression)}. Field names are ` +
				"case-sensitive; check the result summary for the exact names, and " +
				"match a dotted key with bracket notation like @['a.b.c'].",
		);

	const maxMatches = Math.max(0, opts.maxMatches ?? DEFAULT_MAX_MATCHES);
	const limited = matches.slice(0, maxMatches);
	const header =
		limited.length < matches.length
			? `${matches.length} matches; showing the first ${limited.length}.`
			: `${matches.length} matches.`;
	const json = JSON.stringify(limited, null, 2);
	return {
		blocks: [
			{ type: "text", text: header },
			{ type: "text", text: answerWithin(store, limited, json, opts) },
		],
		matches: matches.length,
		json,
	};
}

/**
 * The serialized matches, cut to a budget and citable beyond it.
 *
 * The cut answer is stored under its own handle rather than
 * pointing back at the original, because what the caller wants
 * next is a narrower question about these matches, not about the
 * payload they came from. Following a handle should move forward.
 */
function answerWithin(
	store: ResultStore,
	matches: readonly unknown[],
	json: string,
	opts: QueryOptions,
): string {
	const budget = opts.limitBytes ?? DEFAULT_ANSWER_BYTES;
	const bounded = withinLineBudget(json, budget);
	if (bounded.cut === 0) return bounded.text;

	return cite(store, {
		payload: matches,
		view:
			`${bounded.text}\n\n` +
			`Cut ${bounded.cut.toLocaleString()} of ` +
			`${bounded.total.toLocaleString()} lines to fit the ` +
			`${budget.toLocaleString()} byte budget. Project fewer fields, ` +
			"or filter before selecting.",
		shown: bounded.shown,
		total: bounded.total,
		unit: "lines",
		stored: { count: matches.length, unit: "matches" },
	}).text;
}

/** A note about a query that could not run, itself bounded. */
function note(message: string): QueryAnswer {
	return { blocks: [{ type: "text", text: `[${echo(message)}]` }] };
}

/** Bound a caller's own string before echoing it back. */
function echo(text: string): string {
	return text.length > MAX_EXPRESSION_ECHO
		? `${text.slice(0, MAX_EXPRESSION_ECHO)}...`
		: text;
}
