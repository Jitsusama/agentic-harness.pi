import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	buildDiscoverySections,
	type DiscoveryEntry,
	renderToolDiscovery,
} from "../render/tools-list.js";
import type { McpContent, McpToolResult } from "../types.js";

const DEFAULT_SEARCH_LIMIT = 25;

/** Score a tool against search terms: it must contain every term, then name, backend, summary and hint matches accrue. */
export function scoreToolName(
	entry: { name: string; backend: string; summary?: string; hint?: string },
	terms: string[],
): number {
	if (terms.length === 0) return 1;
	const name = entry.name.toLowerCase();
	const backend = entry.backend.toLowerCase();
	const summary = (entry.summary ?? "").toLowerCase();
	const hint = (entry.hint ?? "").toLowerCase();
	const haystack = `${name} ${backend} ${summary} ${hint}`;
	if (!terms.every((term) => haystack.includes(term))) return 0;

	let score = 0;
	for (const term of terms) {
		if (name === term) score += 100;
		else if (name.startsWith(term)) score += 40;
		else if (name.includes(term)) score += 20;
		if (backend === term || backend.startsWith(term)) score += 15;
		if (summary.includes(term)) score += 5;
		if (hint.includes(term)) score += 3;
	}
	return score;
}

/** Rank entries by relevance to the query, apply the hints for scoring, and cap the result. */
export function searchTools(
	entries: DiscoveryEntry[],
	query: string | undefined,
	opts: { limit?: number; hints?: Record<string, string> } = {},
): DiscoveryEntry[] {
	const terms = (query ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);
	return entries
		.map((entry) => ({
			entry,
			score: scoreToolName(
				{ ...entry, hint: opts.hints?.[entry.backend] },
				terms,
			),
		}))
		.filter((match) => match.score > 0)
		.sort(
			(a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
		)
		.slice(0, opts.limit ?? DEFAULT_SEARCH_LIMIT)
		.map((match) => match.entry);
}

/** Extract the target tool's arguments from the run-tool params, dropping the control keys and parsing a JSON string. */
export function extractRunToolArguments(
	params: Record<string, unknown>,
): Record<string, unknown> {
	const passthrough: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (key !== "name" && key !== "arguments") passthrough[key] = value;
	}

	const args = params.arguments;
	if (args === undefined) return passthrough;
	if (isRecord(args)) return { ...passthrough, ...args };
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (isRecord(parsed)) return { ...passthrough, ...parsed };
		} catch {
			// Not valid JSON; fall through to the validation error.
		}
	}
	throw new Error("run_tool arguments must be an object when provided");
}

/** One progressive helper tool: a name, a description, and a run that returns a result. */
export interface HelperDescriptor {
	name: string;
	description: string;
	run(
		params: Record<string, unknown>,
		ctx: ExtensionContext,
	): Promise<McpToolResult>;
}

/**
 * Build the three progressive helpers under `namespace`: search returns a
 * discovery listing, describe returns a tool's detail, and run-tool validates
 * the name against the enabled catalog before dispatching through the injected
 * execute path.
 */
export function createProgressiveHelpers(deps: {
	namespace: string;
	catalog: () => DiscoveryEntry[];
	hints: Record<string, string>;
	describe: (name: string) => string | undefined;
	runTool: (
		name: string,
		args: Record<string, unknown>,
		ctx: ExtensionContext,
	) => Promise<McpToolResult>;
	searchLimit?: number;
}): HelperDescriptor[] {
	const { namespace, catalog, hints, describe, runTool } = deps;

	return [
		{
			name: `${namespace}_search_tools`,
			description:
				"Search the available tools by keyword and list them by backend.",
			async run(params) {
				const query =
					typeof params.query === "string" ? params.query : undefined;
				const backend =
					typeof params.backend === "string" ? params.backend : undefined;
				const entries = catalog().filter(
					(entry) => !backend || entry.backend === backend,
				);
				const ranked = searchTools(entries, query, {
					limit: deps.searchLimit,
					hints,
				});
				return textResult(
					renderToolDiscovery(buildDiscoverySections(ranked, { hints })),
				);
			},
		},
		{
			name: `${namespace}_describe`,
			description: "Describe a tool: its purpose and arguments.",
			async run(params) {
				const name = typeof params.name === "string" ? params.name : "";
				return textResult(describe(name) ?? `No tool named ${name}.`);
			},
		},
		{
			name: `${namespace}_run_tool`,
			description: "Run a tool by name with the given arguments.",
			async run(params, ctx) {
				const name = typeof params.name === "string" ? params.name : "";
				if (!catalog().some((entry) => entry.name === name)) {
					return textResult(`Unknown or disabled tool: ${name}.`, true);
				}
				return runTool(name, extractRunToolArguments(params), ctx);
			},
		},
	];
}

function textResult(text: string, isError = false): McpToolResult {
	const content: McpContent[] = [{ type: "text", text }];
	return { content, isError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
