/**
 * A finding that belongs to a stack rather than to one change.
 *
 * Reviewing a stack one change at a time hides the findings that only
 * exist between changes: an interface introduced at the base and used
 * wrongly at the tip, a migration split so the middle change cannot
 * deploy on its own. Asking about the whole stack at once surfaces
 * those, but only if a finding can say it is about several changes.
 *
 * So a span, and not a duplicate on each change. Repeating one
 * observation on every change it touches makes a reader answer it
 * three times and leaves three places to resolve it, and the thing
 * that made it worth saying, that it is *between* them, is exactly
 * what gets lost.
 *
 * A span names refs rather than positions. A stack renumbers itself
 * every time somebody restacks it, so a finding recorded as "the
 * second change" is wrong as soon as anything lands underneath.
 */

import { isRecord } from "../../../internal/record.ts";
import type { ChangeRef } from "../change.ts";
import type { Finding, FindingOrigin } from "../finding.ts";
import { readWireFinding, SAID_NOTHING, saysTheSame } from "./harvest.ts";
import { ANSWER_WAS_CUT_OFF, readAnswer, wireText } from "./wire.ts";

/** The changes a finding is about, in stack order. */
export interface FindingSpan {
	/** One ref for an ordinary finding, several for a cross-change one. */
	refs: string[];
}

/**
 * Other names a reviewer gives a stack's changes, each to the refs it
 * could mean: a change's label, its id, the label's short form after
 * its last `#`, as `#7034` for `Jitsusama/core.nix#7034`, and its web
 * page. A reviewer reads each change's title and body, which name it
 * that way, so a finding said at `#7034` is about that change and is
 * placed there. A name two changes answer to is held with both, so a
 * finding said at it is dropped rather than placed at a guess.
 */
export type StackAliases = ReadonlyMap<string, readonly string[]>;

/** One change in a stack, as `stackAliases` names it. */
export interface AliasedChange {
	/** The ref the stack knows it by. */
	ref: string;
	change: ChangeRef;
	/** Its web page, when its backend has one. */
	url?: string;
}

/** The other names of each change in a stack, for `StackAliases`. */
export function stackAliases(changes: readonly AliasedChange[]): StackAliases {
	const aliases = new Map<string, string[]>();
	for (const { ref, change, url } of changes) {
		const hash = change.label.lastIndexOf("#");
		const names = [
			change.label,
			change.id,
			...(hash === -1 ? [] : [change.label.slice(hash)]),
			...(url === undefined ? [] : [url]),
		];
		for (const name of names) {
			if (name !== "" && name !== ref) answersTo(aliases, name, ref);
		}
	}
	return aliases;
}

/**
 * How a reviewer may write a branch other than as the stack gives it:
 * as git's full ref, its short `heads/` form, or as the remote holds
 * it, which is how a reviewer reading the tree's history sees it.
 * Only `origin`, the remote a round's tree is fetched from, since any
 * first segment read as a remote would make `jitsusama/topic` mean
 * `topic` too.
 */
const BRANCH_FORMS = [
	"refs/heads/",
	"heads/",
	"origin/",
	"remotes/origin/",
	"refs/remotes/origin/",
] as const;

/** The prefix git gives a branch's full ref. */
const BRANCH_REF = "refs/heads/";

/**
 * Every name a finding may give a stack's change by, each to the refs
 * it could mean: its aliases, and its branch in each of `BRANCH_FORMS`.
 * A ref under `refs/` but not a branch, such as a tag, has no other
 * form, since git's own short forms of one aren't a branch's.
 */
function changeNames(
	stackRefs: readonly string[],
	aliases: StackAliases | undefined,
): StackAliases {
	const names = new Map<string, string[]>();
	for (const [name, refs] of aliases ?? []) {
		for (const ref of refs) answersTo(names, name, ref);
	}
	for (const ref of stackRefs) {
		const branch = ref.startsWith(BRANCH_REF)
			? ref.slice(BRANCH_REF.length)
			: ref.startsWith("refs/")
				? undefined
				: ref;
		if (branch === undefined || branch === "") continue;
		for (const form of [branch, ...BRANCH_FORMS.map((at) => at + branch)]) {
			if (form !== ref) answersTo(names, form, ref);
		}
	}
	return names;
}

/** Hold that `name` may mean `ref`, beside whatever else it may mean. */
function answersTo(names: Map<string, string[]>, name: string, ref: string) {
	const held = names.get(name);
	if (held === undefined) names.set(name, [ref]);
	else if (!held.includes(ref)) held.push(ref);
}

/** A finding plus the changes it is about. */
export interface SpannedFinding {
	span: FindingSpan;
	finding: Omit<Finding, "id">;
}

/** What came out of one stack-wide answer. */
export interface StackHarvest {
	/**
	 * Of the warnings, the ones about recorded entries rather than
	 * about the answer's shape. Named for the same reason the single
	 * change's harvest names them: the caller that needs them is the
	 * one replacing the whole list.
	 */
	recordedWarnings?: string[];
	findings: SpannedFinding[];
	warnings: string[];
}

/**
 * Read a stack-wide answer, warning about what it dropped.
 *
 * `witnessFor` is asked for the witness of the change a finding is
 * said at, because each change has its own diff: checking a line
 * finding on the tip against the base's diff would degrade a perfectly
 * good anchor for no reason. `aliases` places a finding that names a
 * change another way.
 */
export function harvestStackFindings(
	text: string,
	origin: FindingOrigin,
	stackRefs: readonly string[],
	witnessFor?: (ref: string) => string | undefined,
	aliases?: StackAliases,
): StackHarvest {
	const { parsed, truncated } = readAnswer(text, "findings");
	const held = parsed?.findings;
	if (!Array.isArray(held)) {
		return {
			findings: [],
			// A reviewer that produced nothing has not broken a contract
			// about the shape of an answer it never reached. Same rule as
			// a single change's round, and for the same reason: it is the
			// case a journal exists to rescue.
			warnings: [
				text.trim() === ""
					? SAID_NOTHING
					: "Nothing in this answer parsed as a findings array, so no findings could be read from it. An answer with nothing to say should still say findings: [].",
			],
		};
	}

	const findings: SpannedFinding[] = [];
	const warnings: string[] = [];
	if (truncated) warnings.push(ANSWER_WAS_CUT_OFF);
	const names = changeNames(stackRefs, aliases);
	for (const [index, entry] of held.entries()) {
		const at = `findings[${index}]`;
		const span = readSpan(entry, at, stackRefs, warnings, names);
		if (span === undefined) continue;

		const read = readWireFinding(
			entry,
			at,
			origin,
			witnessFor?.(saidAt(span, stackRefs)),
		);
		warnings.push(...read.warnings);
		if (read.finding !== undefined) {
			findings.push({ span, finding: read.finding });
		}
	}
	return { findings, warnings };
}

/**
 * The stack answer, plus what the reviewer wrote down reaching it.
 *
 * The same bargain as a single change's round, with one extra
 * requirement: a recorded finding still has to say which changes it is
 * about, because a stack round's whole job is placing one. An entry
 * that names none is dropped with a warning, exactly as it would be
 * inside an answer.
 */
export function alsoRecordedInStack(
	said: StackHarvest,
	recorded: readonly unknown[] | undefined,
	origin: FindingOrigin,
	stackRefs: readonly string[],
	witnessFor?: (ref: string) => string | undefined,
	aliases?: StackAliases,
): StackHarvest {
	if (recorded === undefined || recorded.length === 0) return said;
	const findings = [...said.findings];
	const recordedWarnings: string[] = [];
	const before = findings.length;
	const names = changeNames(stackRefs, aliases);
	// Keyed with the span, not just the finding. Two changes in a
	// stack can carry the same line at the same path, which is what a
	// stack is, so the same sentence about two of them is two findings
	// and collapsing them would report the wrong change.
	for (const [index, entry] of recorded.entries()) {
		const at = `recorded[${index}]`;
		const span = readSpan(entry, at, stackRefs, recordedWarnings, names);
		if (span === undefined) continue;
		const read = readWireFinding(
			entry,
			at,
			origin,
			witnessFor?.(saidAt(span, stackRefs)),
		);
		recordedWarnings.push(...read.warnings);
		const found = read.finding;
		if (found === undefined) continue;
		if (
			findings.some((held) =>
				sameSpannedFinding(held, { span, finding: found }),
			)
		)
			continue;
		findings.push({ span, finding: found });
	}
	const aboutTheAnswer =
		findings.length > before
			? said.warnings.filter((warning) => warning !== SAID_NOTHING)
			: said.warnings;
	return {
		findings,
		warnings: [...aboutTheAnswer, ...recordedWarnings],
		recordedWarnings,
	};
}

/**
 * The same finding said about the same changes.
 *
 * The span has to match exactly while the finding is compared the
 * forgiving way, because two changes in a stack can carry the same
 * line at the same path, which is what a stack is: the same sentence
 * about two of them is two findings, and collapsing them would report
 * the wrong change.
 */
function sameSpannedFinding(one: SpannedFinding, two: SpannedFinding): boolean {
	return (
		JSON.stringify(one.span) === JSON.stringify(two.span) &&
		saysTheSame(one.finding, two.finding)
	);
}

/**
 * Where a span gets said.
 *
 * The earliest change it touches, because that is where the decision
 * was made and where a reader walking the stack meets it first. Saying
 * it at the tip sends somebody to the consequence and leaves them to
 * work back to the cause.
 */
export function saidAt(
	span: FindingSpan,
	stackRefs: readonly string[],
): string {
	const ordered = inStackOrder(span.refs, stackRefs);
	return ordered[0] ?? span.refs[0] ?? "";
}

/** The changes an entry claims to be about, or nothing plus a warning. */
function readSpan(
	entry: unknown,
	at: string,
	stackRefs: readonly string[],
	warnings: string[],
	names: StackAliases,
): FindingSpan | undefined {
	if (!isRecord(entry)) {
		warnings.push(`${at} is not an object, so it was dropped.`);
		return undefined;
	}

	const claimed = Array.isArray(entry.refs) ? entry.refs : [];
	const named = claimed.flatMap((value) => {
		const ref = wireText(value);
		return ref === undefined ? [] : [ref];
	});

	// A ref as the stack gives it is that change, whatever else it could
	// be read as: it is the name the prompt heads each change with.
	const refsOf = (name: string): readonly string[] =>
		stackRefs.includes(name) ? [name] : (names.get(name) ?? []);
	const known = named.flatMap((name) => {
		const refs = refsOf(name);
		return refs.length === 1 ? refs : [];
	});
	const unknown = named.filter((name) => refsOf(name).length === 0);
	const ambiguous = named.filter((name) => refsOf(name).length > 1);
	for (const name of ambiguous) {
		// Placing it at either would put a finding on a change it may not
		// be about, which reads as true there and is worse than dropping.
		warnings.push(
			`${at} names ${name}, which could be any of ${refsOf(name).join(", ")} in this stack, so it was left out.`,
		);
	}
	if (unknown.length > 0) {
		// Dropping the ref rather than the finding when others survive:
		// a reviewer that named three changes and got one wrong still
		// saw something real about the other two.
		warnings.push(
			`${at} names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a change" : "are not changes"} in this stack, so ${unknown.length === 1 ? "it was" : "they were"} left out.`,
		);
	}

	if (known.length === 0) {
		warnings.push(
			`${at} names no change in this stack, so it was dropped: a finding nobody can place is a finding nobody can read.`,
		);
		return undefined;
	}

	return { refs: inStackOrder(known, stackRefs) };
}

/**
 * Refs in the order the stack reports them, roots before children.
 *
 * A span reported tip-first would read backwards against the stack it
 * describes, and the order a model happened to list them in carries no
 * meaning worth preserving.
 */
function inStackOrder(
	refs: readonly string[],
	stackRefs: readonly string[],
): string[] {
	const unique = [...new Set(refs)];
	return unique.sort((a, b) => stackRefs.indexOf(a) - stackRefs.indexOf(b));
}
