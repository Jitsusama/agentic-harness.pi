/**
 * Reviewer response parser.
 *
 * Real-world LLM output is messy. The parser extracts
 * the first plausible JSON block from a response,
 * validates each finding entry against the shared
 * `CouncilFinding` schema, and returns the typed
 * findings plus a list of warnings for the caller to
 * surface. One bad entry doesn't abort the batch; we
 * keep the good ones.
 *
 * The validation contract lives in `schemas.ts` so the
 * subagent's `verify_output` tool and the parent's
 * parser cannot drift: anything the subagent verifies
 * green is something the parser will accept here.
 *
 * The parser is pure and synchronous. It owns id
 * assignment (sequential from `startId`), origin
 * stamping, category inference and the tiny bit of
 * post-schema normalisation the schema can't express
 * (whitespace-only strings).
 */

import { Value } from "@sinclair/typebox/value";
import type { Finding } from "./findings.js";
import { CouncilFinding } from "./schemas.js";

/** Caller-supplied context for parsing. */
export interface ParseContext {
	/** Reviewer that produced this output. */
	readonly reviewerId: string;
	/** Council run this output belongs to. */
	readonly runId: string;
	/** Id to assign the first finding; subsequent get startId + 1, ... */
	readonly startId: number;
}

/** Parse result: typed findings plus parse warnings. */
export interface ParseResult {
	readonly findings: Finding[];
	readonly warnings: string[];
}

/**
 * Parse a reviewer's response into structured findings.
 * Warnings carry context for the caller to surface but
 * don't abort parsing.
 */
export function parseReviewerOutput(
	text: string,
	context: ParseContext,
): ParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			findings: [],
			warnings: ["Reviewer response contained no JSON block"],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			findings: [],
			warnings: [`Reviewer JSON failed to parse: ${message}`],
		};
	}

	const rawFindings = extractFindingsArray(parsed);
	if (rawFindings === null) {
		return {
			findings: [],
			warnings: [
				'Reviewer JSON did not contain a "findings" array at the top level',
			],
		};
	}

	const findings: Finding[] = [];
	const warnings: string[] = [];
	let nextId = context.startId;

	for (let i = 0; i < rawFindings.length; i++) {
		const raw = rawFindings[i];
		if (!Value.Check(CouncilFinding, raw)) {
			warnings.push(`Finding at index ${i} is malformed; skipped`);
			continue;
		}
		// Schema accepts " " as a string of length 1; we
		// don't want that promoted into a real comment.
		if (raw.subject.trim() === "" || raw.discussion.trim() === "") {
			warnings.push(`Finding at index ${i} is malformed; skipped`);
			continue;
		}
		findings.push(toFinding(raw, nextId, context));
		nextId++;
	}

	return { findings, warnings };
}

function extractJson(text: string): string | null {
	// Scan for the first balanced JSON object rather than
	// trusting markdown fence delimiters. Finding discussions
	// can legitimately mention ``` inside JSON strings, and
	// a non-greedy fenced-block regex would truncate those
	// otherwise valid payloads.
	const trimmedStart = text.search(/\S/);
	if (trimmedStart === -1) return null;
	if (text[trimmedStart] === "{") return balancedObject(text, trimmedStart);
	const fenceStart = text.indexOf("```json");
	const searchStart = fenceStart === -1 ? 0 : fenceStart;
	const objectStart = text.indexOf("{", searchStart);
	if (objectStart === -1) return null;
	return balancedObject(text, objectStart);
}

function balancedObject(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1).trim();
		}
	}
	return null;
}

function extractFindingsArray(parsed: unknown): unknown[] | null {
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (!Array.isArray(record.findings)) return null;
	return record.findings;
}

/**
 * Build the internal `Finding` from a schema-validated
 * raw entry. The schema guarantees the input shape; this
 * step stamps id, origin, state, defaults decorations
 * and infers category from location.
 */
function toFinding(
	raw: CouncilFinding,
	id: number,
	context: ParseContext,
): Finding {
	const category: Finding["category"] =
		raw.location.kind === "global" ? "scope" : "file";
	return {
		id,
		location: raw.location,
		label: raw.label,
		decorations: raw.decorations ?? [],
		subject: raw.subject,
		discussion: raw.discussion,
		category,
		severity: raw.severity,
		confidence: raw.confidence,
		threadRelation: raw.threadRelation,
		origin: {
			kind: "council",
			runId: context.runId,
			reviewerId: context.reviewerId,
		},
		state: "draft",
	};
}
