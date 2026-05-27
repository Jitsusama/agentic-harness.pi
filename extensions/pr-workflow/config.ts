/**
 * Configuration-file defaults for pr-workflow reviewer setup.
 *
 * The extension intentionally ships with no built-in council or
 * judge roster. Users can opt into defaults by writing a JSON file
 * at `$PR_WORKFLOW_CONFIG`, `$XDG_CONFIG_HOME/pi/pr-workflow.json`,
 * or `~/.config/pi/pr-workflow.json`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	CouncilReviewer,
	ReviewerThinkingLevel,
} from "../../lib/subagent/subagent.js";

const CONFIG_ENV_VAR = "PR_WORKFLOW_CONFIG";
const CONFIG_FILENAME = "pr-workflow.json";
const CONFIG_DIR = "pi";
const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"low",
	"medium",
	"high",
]);

/** Reviewer defaults loaded from a config file. */
export interface PrWorkflowConfigDefaults {
	readonly reviewers?: readonly CouncilReviewer[];
	readonly judge?: CouncilReviewer;
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
): Promise<PrWorkflowConfigLoadResult> {
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
	reviewers?: CouncilReviewer[];
	judge?: CouncilReviewer;
};

type ReviewerParseResult =
	| { ok: true; reviewer: CouncilReviewer }
	| { ok: false; error: string };

type ReviewersParseResult =
	| { ok: true; reviewers: CouncilReviewer[] }
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

function parseReviewer(value: unknown, path: string): ReviewerParseResult {
	if (!isRecord(value))
		return { ok: false, error: `${path} must be an object` };
	const id = readRequiredString(value, "id", path);
	if (!id.ok) return id;
	if (id.value.trim() === "") {
		return { ok: false, error: `${path}.id must not be empty` };
	}

	const reviewer: MutableCouncilReviewer = { id: id.value };
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

type MutableCouncilReviewer = {
	id: string;
	model?: string;
	thinkingLevel?: ReviewerThinkingLevel;
	tools?: readonly string[];
};

type StringReadResult =
	| { ok: true; value: string }
	| { ok: false; error: string };

type OptionalStringReadResult =
	| { ok: true; value?: string }
	| { ok: false; error: string };

type OptionalThinkingLevelReadResult =
	| { ok: true; value?: ReviewerThinkingLevel }
	| { ok: false; error: string };

type OptionalStringArrayReadResult =
	| { ok: true; value?: readonly string[] }
	| { ok: false; error: string };

function readRequiredString(
	object: Record<string, unknown>,
	key: string,
	path: string,
): StringReadResult {
	const value = object[key];
	if (typeof value !== "string") {
		return { ok: false, error: `${path}.${key} must be a string` };
	}
	return { ok: true, value };
}

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
