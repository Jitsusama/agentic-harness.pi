import type { McpTool } from "../types.js";

/** Whether a tool is registered directly, hidden behind progressive helpers, or not registered at all. */
export type ToolMode = "direct" | "progressive" | "disabled";

/**
 * The knobs that decide which tools reach the model and how.
 *
 * `include` and `exclude` are glob lists over tool names; `progressive` and
 * `direct` are glob lists over tool names or backend groups. When `include` is
 * non-empty it becomes an allow-list. `autoProgressive` and
 * `autoProgressiveThreshold` govern hiding a large backend behind helpers.
 */
export interface SurfaceConfig {
	include: string[];
	exclude: string[];
	progressive: string[];
	direct: string[];
	progressiveHints: Record<string, string>;
	autoProgressiveThreshold: number;
	autoProgressive: boolean;
}

/**
 * Server-specific behaviour the core defers to, all optional.
 *
 * A server that sets none of these gets the core defaults. The interface names
 * no particular server, so the core can depend on it without inverting the
 * layering; a downstream policy structurally satisfies it.
 */
export interface ServerPolicy {
	/** Fill in concise argument defaults the server prefers, where the schema declares them. */
	argDefaults?(
		tool: McpTool,
		args: Record<string, unknown>,
	): Record<string, unknown>;
	/** Whether calling the tool changes state and should pass through a write gate. */
	writeSignal?(tool: McpTool): boolean;
	/** Per-tool display truncation limits, or null to leave the output untouched. */
	truncationLimits?(
		tool: McpTool,
	): { maxLines: number; maxBytes: number } | null;
	/** A one-line hint describing what a backend group is for. */
	hint?(backend: string): string;
	/** Group a tool name under a backend, overriding the first-token default. */
	backendOf?(name: string): string;
}

/** Group a tool name by its first underscore-delimited token; single-token names fall to a misc bucket. */
export function defaultBackendOf(name: string): string {
	const first = name.split("_")[0];
	return first || "(misc)";
}

const GLOB_META = /[.+?^${}()|[\]\\]/g;

/** Compile a glob (with `*` wildcards) to an anchored RegExp; all other metacharacters are literal. */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(GLOB_META, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

/** Whether the name matches any of the non-empty patterns. */
function matchesAnyGlob(name: string, patterns: string[]): boolean {
	return patterns.some(
		(pattern) => pattern !== "" && globToRegex(pattern).test(name),
	);
}

/** Whether the tool name or its backend group matches any pattern. */
function matchesNameOrBackend(
	name: string,
	patterns: string[],
	backendOf: (name: string) => string,
): boolean {
	return (
		matchesAnyGlob(name, patterns) || matchesAnyGlob(backendOf(name), patterns)
	);
}

/** Whether the tool passes the include/exclude filter. */
function isEnabled(name: string, cfg: SurfaceConfig): boolean {
	if (matchesAnyGlob(name, cfg.exclude)) return false;
	if (cfg.include.length > 0) return matchesAnyGlob(name, cfg.include);
	return true;
}

/**
 * Classify a tool as direct, progressive or disabled.
 *
 * Exclude always wins; a non-empty include is an allow-list. An enabled tool is
 * direct unless a `direct` pattern is absent and either a `progressive` pattern
 * matches or the tool's backend has more than `autoProgressiveThreshold`
 * enabled tools with `autoProgressive` on. Grouping for the threshold uses the
 * injected `backendOf`.
 */
export function resolveToolMode(
	tool: McpTool,
	cfg: SurfaceConfig,
	allTools: McpTool[],
	backendOf: (name: string) => string,
): ToolMode {
	if (!isEnabled(tool.name, cfg)) return "disabled";
	if (matchesNameOrBackend(tool.name, cfg.direct, backendOf)) return "direct";
	if (matchesNameOrBackend(tool.name, cfg.progressive, backendOf))
		return "progressive";
	if (!cfg.autoProgressive || allTools.length === 0) return "direct";

	const backend = backendOf(tool.name);
	const enabledInBackend = allTools.filter(
		(other) => backendOf(other.name) === backend && isEnabled(other.name, cfg),
	).length;
	return enabledInBackend > cfg.autoProgressiveThreshold
		? "progressive"
		: "direct";
}
