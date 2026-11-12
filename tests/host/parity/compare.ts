/**
 * Compares two recordings of a parity scenario: what the provider was sent
 * and every event pi's extensions heard. Before comparing, each side's own
 * folders, ports, times and generated ids are replaced by stable labels, an
 * id keeping one label wherever it recurs, so only behaviour differs.
 * Events are aligned by type first, so one missing event reads as missing
 * rather than as every event after it differing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One way two recordings differ, at a JSON path. */
export interface Difference {
	readonly path: string;
	readonly kind?: "missing-event" | "extra-event" | "missing-artifact";
	readonly expected?: unknown;
	readonly actual?: unknown;
}

/**
 * Keys whose values are times, left out of every comparison. `of`,
 * `preparedMs` and `firstTokenMs` are a model call's timing entry's
 * (observability-workflow's timing.ts), `of` its start in ms.
 */
const TIMING = new Set([
	"timestamp",
	"durationMs",
	"summaryMs",
	"waitedMs",
	"of",
	"preparedMs",
	"firstTokenMs",
]);

/** Keys whose values are generated ids, compared by where they recur. */
const REFERENCES = new Set([
	"messageEntryId",
	"toolResultEntryIds",
	"firstKeptEntryId",
	"parentId",
	"entryId",
	"sessionId",
	"workItemId",
	"toolCallId",
	"parentToolCallId",
	"tool_use_id",
	"origin_id",
	"root_span_id",
	"span_id",
	"span_path",
	"trace_id",
	"prev_trace_id",
]);

/** A generated id in an `id` field: a uuid's first part, or a call or message id. */
const GENERATED_ID = /^(?:[a-f0-9]{8}(?:-|$)|call_|msg_)/;
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} .* GMT$/;
const LOCAL_PORT = /http:\/\/127\.0\.0\.1:\d+/g;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const UUID =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * What the host differs from pi in by being the host: the harness journal
 * confirms each turn durable, where plain pi can't.
 */
const EXPECTED_OF_THE_HOST = /\.journal\.last\.(persistence|reasons|status)$/;

/** Whether a difference is one the host makes by being the host. */
export function expectedOfTheHost(difference: Difference): boolean {
	return (
		difference.kind === undefined && EXPECTED_OF_THE_HOST.test(difference.path)
	);
}

/** A recording with its folders, ports, times and generated ids replaced by labels. */
export function normalise(
	value: unknown,
	roots: readonly (readonly [string, string])[],
): unknown {
	const ids = new Map<string, string>();
	const identity = (id: string): string => {
		const known = ids.get(id);
		if (known !== undefined) return known;
		const label = `<id-${ids.size}>`;
		ids.set(id, label);
		return label;
	};
	const visit = (item: unknown, key: string): unknown => {
		if (key === "parameters" || key === "input_schema") return item;
		if (Array.isArray(item)) return item.map((each) => visit(each, key));
		if (item !== null && typeof item === "object")
			return Object.fromEntries(
				Object.keys(item)
					.sort()
					.filter((name) => !TIMING.has(name))
					.map((name) => [name, visit(Reflect.get(item, name), name)]),
			);
		if (typeof item !== "string") return item;
		if (key === "date" && HTTP_DATE.test(item)) return "<time>";
		if (REFERENCES.has(key) || (key === "id" && GENERATED_ID.test(item)))
			return identity(item);
		let text = item;
		for (const [path, label] of roots) text = text.replaceAll(path, label);
		return text
			.replace(LOCAL_PORT, "http://127.0.0.1:<port>")
			.replace(ISO_TIME, "<time>")
			.replace(UUID, identity);
	};
	return visit(value, "");
}

/** Every leaf at which two values differ. */
export function differences(
	expected: unknown,
	actual: unknown,
	path = "$",
): Difference[] {
	if (Object.is(expected, actual)) return [];
	if (Array.isArray(expected) && Array.isArray(actual)) {
		const found: Difference[] =
			expected.length === actual.length
				? []
				: [
						{
							path: `${path}.length`,
							expected: expected.length,
							actual: actual.length,
						},
					];
		const longest = Math.max(expected.length, actual.length);
		for (let index = 0; index < longest; index += 1)
			found.push(
				...differences(
					expected.at(index),
					actual.at(index),
					`${path}[${index}]`,
				),
			);
		return found;
	}
	if (
		expected !== null &&
		actual !== null &&
		typeof expected === "object" &&
		typeof actual === "object" &&
		!Array.isArray(expected) &&
		!Array.isArray(actual)
	) {
		const keys = [
			...new Set([...Object.keys(expected), ...Object.keys(actual)]),
		].sort();
		return keys.flatMap((key) =>
			differences(
				Reflect.get(expected, key),
				Reflect.get(actual, key),
				`${path}.${key}`,
			),
		);
	}
	return [{ path, expected, actual }];
}

/** The two event lists' differences, aligned by the longest run of matching types. */
export function alignedEvents(
	expected: readonly unknown[],
	actual: readonly unknown[],
): Difference[] {
	const width = actual.length + 1;
	const common = new Array<number>((expected.length + 1) * width).fill(0);
	const at = (i: number, j: number): number => common.at(i * width + j) ?? 0;
	const typeOf = (list: readonly unknown[], index: number): unknown => {
		const event = list.at(index);
		return event !== null && typeof event === "object"
			? Reflect.get(event, "type")
			: undefined;
	};
	for (let i = expected.length - 1; i >= 0; i -= 1)
		for (let j = actual.length - 1; j >= 0; j -= 1)
			common[i * width + j] =
				typeOf(expected, i) === typeOf(actual, j)
					? 1 + at(i + 1, j + 1)
					: Math.max(at(i + 1, j), at(i, j + 1));
	const found: Difference[] = [];
	let i = 0;
	let j = 0;
	while (i < expected.length || j < actual.length) {
		const both = i < expected.length && j < actual.length;
		if (both && typeOf(expected, i) === typeOf(actual, j)) {
			found.push(
				...differences(
					expected.at(i),
					actual.at(j),
					`events[${i}:${String(typeOf(expected, i))}]`,
				),
			);
			i += 1;
			j += 1;
		} else if (
			j === actual.length ||
			(i < expected.length && at(i + 1, j) >= at(i, j + 1))
		) {
			found.push({
				path: `events[${i}]`,
				kind: "missing-event",
				expected: typeOf(expected, i),
			});
			i += 1;
		} else {
			found.push({
				path: `events.actual[${j}]`,
				kind: "extra-event",
				actual: typeOf(actual, j),
			});
			j += 1;
		}
	}
	return found;
}

/** How two recordings of one scenario differ, each in its own folder. */
export function compareRecordings(
	expectedDir: string,
	actualDir: string,
	requestsExpected: boolean,
): Difference[] {
	const missing: Difference[] = [];
	for (const file of [
		"trace.ndjson",
		...(requestsExpected ? ["requests.ndjson"] : []),
	])
		for (const dir of [expectedDir, actualDir])
			if (!existsSync(join(dir, file)))
				missing.push({ path: dir, kind: "missing-artifact", expected: file });
	const read = (dir: string, file: string) =>
		normalise(records(join(dir, file)), roots(dir));
	return [
		...missing,
		...differences(
			read(expectedDir, "requests.ndjson"),
			read(actualDir, "requests.ndjson"),
			"requests",
		),
		...alignedEvents(
			eventsOf(read(expectedDir, "trace.ndjson")),
			eventsOf(read(actualDir, "trace.ndjson")),
		),
	];
}

/** A recording's own folders, and the label each is compared under. */
function roots(dir: string): [string, string][] {
	return [
		[join(dir, "repo"), "<cwd>"],
		[join(dir, "home"), "<home>"],
		[join(dir, "sessions"), "<sessions>"],
		[join(dir, "tmp"), "<tmp>"],
		[join(dir, "runtime"), "<runtime>"],
	];
}

/** A JSON-lines file's records, none when it is absent. */
export function records(path: string): unknown[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): unknown => JSON.parse(line));
}

function eventsOf(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}
