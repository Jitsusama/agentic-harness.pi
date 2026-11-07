/**
 * Steps: what a run is doing now, said in its presence beside the bare
 * step name, so the launcher can say "bash: nix build .#checks" rather
 * than "bash".
 *
 * A run is calling a tool, thinking between tools, or waiting on its
 * person at a gate it raised mid-run. The detail is the one argument
 * that says what the call is about (a command, a path, a query), cut to
 * one short line: presence is shared across the person's machines, and
 * the whole of a command is the session's to show, not the launcher's.
 */

/** What a run is doing. */
export type StepKind = "tool" | "thinking" | "waiting";

/** A run's step, as its presence says it. */
export interface StepDetail {
	readonly kind: StepKind;
	/** The tool, for a tool; the want's kind, for waiting; empty for thinking. */
	readonly name: string;
	/** What it is about, in one short line; empty when nothing says. */
	readonly detail: string;
	/** When it began, as an ISO time. */
	readonly since: string;
}

/** The longest a step's detail is said at. */
export const DETAIL_CHARS = 80;

/** The arguments that say what a call is about, tried in this order. */
const TELLING = [
	"command",
	"path",
	"file_path",
	"query",
	"url",
	"action",
] as const;

/**
 * What a tool call is about, from its arguments: the first that tells,
 * else its first string, on one line no longer than DETAIL_CHARS.
 */
export function toolDetail(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const given = args as Record<string, unknown>;
	const telling = TELLING.map((key) => given[key]).find(
		(value): value is string => typeof value === "string" && value !== "",
	);
	const first = Object.values(given).find(
		(value): value is string => typeof value === "string" && value !== "",
	);
	return clipped(telling ?? first ?? "");
}

/** A step's name as the plain `step` field says it, for older readers. */
export function stepName(step: Omit<StepDetail, "since">): string {
	return step.kind === "tool" ? step.name : step.kind;
}

function clipped(text: string): string {
	const line = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
	return line.length <= DETAIL_CHARS
		? line
		: `${line.slice(0, DETAIL_CHARS - 1).trimEnd()}\u2026`;
}

/** Whether a value read from outside is a step as this version says it. */
export function isStepDetail(value: unknown): value is StepDetail {
	if (typeof value !== "object" || value === null) return false;
	const { kind, name, detail, since } = value as Record<string, unknown>;
	return (
		(kind === "tool" || kind === "thinking" || kind === "waiting") &&
		typeof name === "string" &&
		typeof detail === "string" &&
		typeof since === "string"
	);
}
