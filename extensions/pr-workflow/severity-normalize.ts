/**
 * Severity normalization for reviewer-emitted findings.
 *
 * The canonical schema (`FindingSeverity` in
 * `./schemas.ts`) accepts only `critical / medium / minor`.
 * Real models use richer vocabularies — grok-4.3 emits
 * `"required"`, others emit `"blocking"`, `"high"`,
 * `"info"`, etc. Severity is documented as optional, so a
 * vocabulary mismatch must not reject the whole finding.
 *
 * The normalizer maps common aliases into the canonical
 * set and drops unrecognized values with a warning. It's
 * applied in two places:
 *
 *   1. The verify pack runs it on the subagent's payload
 *      before the schema check, so reviewers iterate to
 *      `ok: true` instead of bouncing on severity.
 *   2. The parent parsers run it on the canonical text
 *      before their own schema check, because the
 *      subagent's `finalAssistantText` carries the raw
 *      pre-normalized JSON the model wrote. Without this
 *      second pass the finding would verify green and
 *      then get dropped as malformed at the parent.
 *
 * The walk is shape-aware (only touches `findings`,
 * `crossPr` and `perPr.*` arrays) so it doesn't rewrite
 * stray `severity` keys nested in unrelated structures.
 */

import type { FindingSeverity } from "./schemas.js";

/**
 * Aliases mapped to the canonical set. The list aims for
 * the dominant meaning in code-review vocabularies:
 * `high`/`blocking`/`required` are usually "merge-blocker"
 * shape, `low`/`info`/`optional` are usually "won't block".
 */
const SEVERITY_ALIASES: ReadonlyMap<string, FindingSeverity> = new Map<
	string,
	FindingSeverity
>([
	["critical", "critical"],
	["required", "critical"],
	["blocking", "critical"],
	["block", "critical"],
	["high", "critical"],
	["medium", "medium"],
	["moderate", "medium"],
	["normal", "medium"],
	["minor", "minor"],
	["low", "minor"],
	["optional", "minor"],
	["non-blocking", "minor"],
	["nonblocking", "minor"],
	["nice-to-have", "minor"],
	["info", "minor"],
	["informational", "minor"],
]);

/** Result of normalizing severity across a payload. */
export interface SeverityNormalization {
	readonly value: unknown;
	readonly warnings: readonly string[];
}

/**
 * Walk every finding-shaped path in the parsed input and
 * normalize the optional `severity` field. Unknown values
 * are dropped from the finding (severity is optional) and
 * surfaced as warnings so the caller can flag the
 * reviewer in its summary.
 */
export function normalizeFindingSeverities(
	input: unknown,
): SeverityNormalization {
	if (typeof input !== "object" || input === null) {
		return { value: input, warnings: [] };
	}
	const warnings: string[] = [];
	const record = input as Record<string, unknown>;
	const clone: Record<string, unknown> = { ...record };

	if (Array.isArray(record.findings)) {
		clone.findings = record.findings.map((item, index) =>
			normalizeSeverityOnFinding(item, `/findings/${index}`, warnings),
		);
	}
	if (Array.isArray(record.crossPr)) {
		clone.crossPr = record.crossPr.map((item, index) =>
			normalizeSeverityOnFinding(item, `/crossPr/${index}`, warnings),
		);
	}
	if (
		record.perPr &&
		typeof record.perPr === "object" &&
		!Array.isArray(record.perPr)
	) {
		const perPr = record.perPr as Record<string, unknown>;
		const clonedPerPr: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(perPr)) {
			if (Array.isArray(value)) {
				clonedPerPr[key] = value.map((item, index) =>
					normalizeSeverityOnFinding(item, `/perPr/${key}/${index}`, warnings),
				);
			} else {
				clonedPerPr[key] = value;
			}
		}
		clone.perPr = clonedPerPr;
	}

	return { value: clone, warnings };
}

function normalizeSeverityOnFinding(
	item: unknown,
	path: string,
	warnings: string[],
): unknown {
	if (typeof item !== "object" || item === null) return item;
	const record = item as Record<string, unknown>;
	if (!("severity" in record)) return item;
	const raw = record.severity;
	if (typeof raw !== "string") return item;
	const alias = SEVERITY_ALIASES.get(raw.trim().toLowerCase());
	if (alias === undefined) {
		warnings.push(
			`Dropped unrecognized severity "${raw}" at ${path}; ` +
				"use one of critical, medium, minor.",
		);
		const { severity: _drop, ...rest } = record;
		return rest;
	}
	if (alias === raw) return item;
	return { ...record, severity: alias };
}
