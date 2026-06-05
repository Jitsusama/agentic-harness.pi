/**
 * Configuration-file defaults for pr-workflow reviewer setup.
 *
 * The extension intentionally ships with no built-in council or
 * judge roster. Users opt into defaults through the `pr-workflow`
 * section of the unified package config at
 * `~/.config/pi/agentic-harness.pi/config.json`. During the
 * transition the legacy standalone file is still read as a
 * fallback when that section is absent: `$PR_WORKFLOW_CONFIG`,
 * `$XDG_CONFIG_HOME/pi/pr-workflow.json`, or
 * `~/.config/pi/pr-workflow.json`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPackageConfig } from "../../lib/internal/config/loader.js";
import { packageConfigPath } from "../../lib/internal/paths.js";
import type {
	CouncilReviewer,
	ReviewerThinkingLevel,
} from "../../lib/subagent/subagent.js";

/** Section key for pr-workflow in the unified package config. */
export const PR_WORKFLOW_SLUG = "pr-workflow";

const CONFIG_ENV_VAR = "PR_WORKFLOW_CONFIG";
const CONFIG_FILENAME = "pr-workflow.json";
const CONFIG_DIR = "pi";
const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

/**
 * A council reviewer as written in the config file. It is the
 * engine spec plus an optional `persona`: the id of the charter
 * the reviewer wears. When `persona` is given and `id` is omitted,
 * the persona id doubles as the reviewer id; when both are given
 * they stay distinct, so the same persona can run more than once
 * with different mechanisms without an id collision.
 */
export interface PrWorkflowReviewerEntry extends CouncilReviewer {
	readonly persona?: string;
}

/** Reviewer defaults loaded from a config file. */
export interface PrWorkflowConfigDefaults {
	readonly reviewers?: readonly PrWorkflowReviewerEntry[];
	readonly judge?: PrWorkflowReviewerEntry;
}

/** Successful config load result. */
export interface LoadedPrWorkflowConfig {
	readonly path: string;
	readonly defaults: PrWorkflowConfigDefaults;
}

/** Config loading result. */
export type PrWorkflowConfigLoadResult =
	| { ok: true; config: LoadedPrWorkflowConfig }
	| { ok: false; path: string; error: string };

/** Config parse result. */
export type PrWorkflowConfigParseResult =
	| { ok: true; defaults: PrWorkflowConfigDefaults }
	| { ok: false; error: string };

/** Return the config path pr-workflow will read. */
export function prWorkflowConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const explicit = env[CONFIG_ENV_VAR];
	if (explicit && explicit.trim() !== "") return explicit;
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg && xdg.trim() !== "") {
		return join(xdg, CONFIG_DIR, CONFIG_FILENAME);
	}
	return join(home, ".config", CONFIG_DIR, CONFIG_FILENAME);
}

/** Load and validate reviewer defaults from the config file. */
export async function loadPrWorkflowConfig(
	path = prWorkflowConfigPath(),
	packagePath = packageConfigPath(),
): Promise<PrWorkflowConfigLoadResult> {
	// During the transition the unified package config wins
	// when it carries a pr-workflow section; otherwise we
	// fall back to the legacy standalone file below.
	const pkg = await loadPackageConfig(packagePath);
	if (pkg.ok) {
		const raw = pkg.config.sections[PR_WORKFLOW_SLUG];
		if (raw !== undefined) {
			const parsed = parsePrWorkflowConfig(raw);
			if (!parsed.ok) {
				return {
					ok: false,
					path: pkg.path,
					error: `Invalid pr-workflow section in ${pkg.path}: ${parsed.error}`,
				};
			}
			return {
				ok: true,
				config: { path: pkg.path, defaults: parsed.defaults },
			};
		}
	}

	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				ok: false,
				path,
				error: `No pr-workflow config found at ${path}.`,
			};
		}
		return {
			ok: false,
			path,
			error: `Could not read pr-workflow config at ${path}: ${errorMessage(error)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			path,
			error: `Could not parse pr-workflow config at ${path}: ${errorMessage(error)}`,
		};
	}

	const result = parsePrWorkflowConfig(parsed);
	if (!result.ok) {
		return {
			ok: false,
			path,
			error: `Invalid pr-workflow config at ${path}: ${result.error}`,
		};
	}
	return { ok: true, config: { path, defaults: result.defaults } };
}

/** Parse reviewer defaults from a JSON-compatible value. */
export function parsePrWorkflowConfig(
	value: unknown,
): PrWorkflowConfigParseResult {
	if (!isRecord(value)) {
		return { ok: false, error: "root must be an object" };
	}

	const defaults: MutablePrWorkflowConfigDefaults = {};
	if ("reviewers" in value && value.reviewers !== undefined) {
		if (!Array.isArray(value.reviewers)) {
			return { ok: false, error: "reviewers must be an array" };
		}
		if (value.reviewers.length === 0) {
			return {
				ok: false,
				error: "reviewers must include at least one reviewer",
			};
		}
		const reviewers = parseReviewers(value.reviewers, "reviewers");
		if (!reviewers.ok) return reviewers;
		defaults.reviewers = reviewers.reviewers;
	}

	if ("judge" in value && value.judge !== undefined) {
		const judge = parseReviewer(value.judge, "judge");
		if (!judge.ok) return judge;
		defaults.judge = judge.reviewer;
	}

	if (!defaults.reviewers && !defaults.judge) {
		return {
			ok: false,
			error: "config must define reviewers, judge, or both",
		};
	}

	if (defaults.reviewers && defaults.judge) {
		const duplicate = defaults.reviewers.find(
			(r) => r.id === defaults.judge?.id,
		);
		if (duplicate) {
			return {
				ok: false,
				error: `judge id duplicates council reviewer id: ${duplicate.id}`,
			};
		}
	}

	return { ok: true, defaults };
}

type MutablePrWorkflowConfigDefaults = {
	reviewers?: PrWorkflowReviewerEntry[];
	judge?: PrWorkflowReviewerEntry;
};

/** Outcome of normalizing one raw reviewer entry. */
export type ReviewerParseResult =
	| { ok: true; reviewer: PrWorkflowReviewerEntry }
	| { ok: false; error: string };

type ReviewersParseResult =
	| { ok: true; reviewers: PrWorkflowReviewerEntry[] }
	| { ok: false; error: string };

function parseReviewers(
	value: readonly unknown[],
	path: string,
): ReviewersParseResult {
	const reviewers: CouncilReviewer[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const result = parseReviewer(value[index], `${path}[${index}]`);
		if (!result.ok) return result;
		if (seen.has(result.reviewer.id)) {
			return {
				ok: false,
				error: `duplicate reviewer id: ${result.reviewer.id}`,
			};
		}
		seen.add(result.reviewer.id);
		reviewers.push(result.reviewer);
	}
	return { ok: true, reviewers };
}

/**
 * Normalize one raw reviewer entry — from the config file or the
 * tool's `reviewers` array — into a {@link PrWorkflowReviewerEntry}.
 * Derives the reviewer id from `id` or, failing that, the persona
 * id, and validates that one of the two is present. Exported so the
 * tool path and the config-file path share one normalization and
 * cannot drift apart.
 */
export function parseReviewer(
	value: unknown,
	path: string,
): ReviewerParseResult {
	if (!isRecord(value))
		return { ok: false, error: `${path} must be an object` };

	const persona = readOptionalString(value, "persona", path);
	if (!persona.ok) return persona;
	if (persona.value !== undefined && persona.value.trim() === "") {
		return { ok: false, error: `${path}.persona must not be empty` };
	}

	// The reviewer id is `id` when present, else the persona id.
	// One of the two must be given: the id is the finding-origin
	// tag, the artifact key and the retry target, so it cannot be
	// absent, but a persona-only entry supplies it for free.
	const explicitId = readOptionalString(value, "id", path);
	if (!explicitId.ok) return explicitId;
	if (explicitId.value !== undefined && explicitId.value.trim() === "") {
		return { ok: false, error: `${path}.id must not be empty` };
	}
	const id = explicitId.value ?? persona.value;
	if (id === undefined) {
		return {
			ok: false,
			error: `${path} must have an id or a persona`,
		};
	}

	const reviewer: MutableReviewerEntry = { id };
	if (persona.value !== undefined) reviewer.persona = persona.value;
	const model = readOptionalString(value, "model", path);
	if (!model.ok) return model;
	if (model.value !== undefined) reviewer.model = model.value;

	const thinkingLevel = readOptionalThinkingLevel(value, path);
	if (!thinkingLevel.ok) return thinkingLevel;
	if (thinkingLevel.value !== undefined) {
		reviewer.thinkingLevel = thinkingLevel.value;
	}

	const tools = readOptionalStringArray(value, "tools", path);
	if (!tools.ok) return tools;
	if (tools.value !== undefined) reviewer.tools = tools.value;

	return { ok: true, reviewer };
}

type MutableReviewerEntry = {
	id: string;
	persona?: string;
	model?: string;
	thinkingLevel?: ReviewerThinkingLevel;
	tools?: readonly string[];
};

type OptionalStringReadResult =
	| { ok: true; value?: string }
	| { ok: false; error: string };

type OptionalThinkingLevelReadResult =
	| { ok: true; value?: ReviewerThinkingLevel }
	| { ok: false; error: string };

type OptionalStringArrayReadResult =
	| { ok: true; value?: readonly string[] }
	| { ok: false; error: string };

function readOptionalString(
	object: Record<string, unknown>,
	key: string,
	path: string,
): OptionalStringReadResult {
	const value = object[key];
	if (value === undefined) return { ok: true };
	if (typeof value !== "string") {
		return { ok: false, error: `${path}.${key} must be a string` };
	}
	return { ok: true, value };
}

function readOptionalThinkingLevel(
	object: Record<string, unknown>,
	path: string,
): OptionalThinkingLevelReadResult {
	const value = object.thinkingLevel;
	if (value === undefined) return { ok: true };
	if (!isThinkingLevel(value)) {
		return {
			ok: false,
			error: `${path}.thinkingLevel must be one of: off, low, medium, high`,
		};
	}
	return { ok: true, value };
}

function readOptionalStringArray(
	object: Record<string, unknown>,
	key: string,
	path: string,
): OptionalStringArrayReadResult {
	const value = object[key];
	if (value === undefined) return { ok: true };
	if (!Array.isArray(value)) {
		return { ok: false, error: `${path}.${key} must be an array of strings` };
	}
	for (const item of value) {
		if (typeof item !== "string") {
			return { ok: false, error: `${path}.${key} must be an array of strings` };
		}
	}
	return { ok: true, value: value.slice() };
}

function isThinkingLevel(value: unknown): value is ReviewerThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
