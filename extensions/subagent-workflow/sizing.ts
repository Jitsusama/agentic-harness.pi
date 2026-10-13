/**
 * What a fleet's jobs run on, and how many a fleet may have.
 *
 * A job that named no model ran on pi's `defaultModel`, which is not
 * the model the session runs whenever the two differ, and nothing said
 * so. Nothing could be set for a quest, a project or a run either, and
 * nothing stopped a fleet of any size.
 *
 * So each setting a job can name is filled in layers, first match
 * winning: the job itself, the run's `defaults`, the loaded quest's
 * entry, the project's entry, the config's `defaults`, and finally the
 * session's own model at high thinking. The same layers a review round
 * chooses its roster by, in the same file, so the two cannot come to
 * work differently. Every answer says what the jobs ran on and which
 * layer chose it.
 */

import {
	isThinkingLevel,
	type ThinkingLevel,
} from "../../lib/thinking/index.ts";

/** The section of the package config this reads. */
export const SUBAGENT_SLUG = "subagent";

/**
 * How many jobs a fleet may run unless the config says otherwise.
 *
 * Room for a sweep of every distinct angle a question usually has, and
 * well short of the fleets that made a cap worth having.
 */
export const DEFAULT_MAX_JOBS = 8;

/**
 * How hard a job thinks when nothing says. High, as a review round
 * does: a fleet is asked because the work matters, and the highest
 * level costs far more than it adds.
 */
export const DEFAULT_THINKING: ThinkingLevel = "high";

/** What a layer may set for every job under it. */
export interface JobSettings {
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly tools?: readonly string[];
	readonly timeoutMs?: number;
	readonly idleTimeoutMs?: number;
}

/** The layers, by name, in the order they are asked. */
export type Layer =
	| "job"
	| "run"
	| "quest"
	| "project"
	| "config"
	| "session"
	| "built-in";

/** The `subagent` section, read and checked. */
export interface FleetConfig {
	readonly defaults: JobSettings;
	readonly quests: Readonly<Record<string, JobSettings>>;
	readonly projects: Readonly<Record<string, JobSettings>>;
	readonly maxJobs: number;
}

/** Where a fleet is asked from. */
export interface FleetPlace {
	readonly run?: JobSettings;
	readonly quest?: string;
	readonly project?: string;
	/** The session's model as `provider/id`, when it has one. */
	readonly sessionModel?: string;
}

/** A job's settings once every layer has had its say. */
export interface SettledJob extends JobSettings {
	/** Which layer chose the model, absent when nothing did. */
	readonly modelFrom?: Layer;
	readonly thinkingFrom: Layer;
}

/**
 * Read the `subagent` section, which may be missing. A section that is
 * there and wrong is refused rather than half-read, naming the field,
 * because a fleet that quietly ignored its settings still costs what a
 * fleet costs.
 */
export function readFleetConfig(
	section: unknown,
	path: string,
): { ok: true; config: FleetConfig } | { ok: false; error: string } {
	if (section === undefined) {
		return {
			ok: true,
			config: {
				defaults: {},
				quests: {},
				projects: {},
				maxJobs: DEFAULT_MAX_JOBS,
			},
		};
	}
	if (!isRecord(section)) {
		return {
			ok: false,
			error: `${SUBAGENT_SLUG} in ${path} must be an object.`,
		};
	}
	const defaults = readSettings(section.defaults, `${SUBAGENT_SLUG}.defaults`);
	if ("error" in defaults)
		return { ok: false, error: `${defaults.error} (${path})` };
	const quests = readKeyed(section.quests, `${SUBAGENT_SLUG}.quests`);
	if ("error" in quests)
		return { ok: false, error: `${quests.error} (${path})` };
	const projects = readKeyed(section.projects, `${SUBAGENT_SLUG}.projects`);
	if ("error" in projects)
		return { ok: false, error: `${projects.error} (${path})` };
	const max = section.maxJobs;
	if (max !== undefined && !(isWholeNumber(max) && max > 0)) {
		return {
			ok: false,
			error: `${SUBAGENT_SLUG}.maxJobs in ${path} must be a whole number above zero.`,
		};
	}
	return {
		ok: true,
		config: {
			defaults: defaults.settings,
			quests: quests.keyed,
			projects: projects.keyed,
			maxJobs: max ?? DEFAULT_MAX_JOBS,
		},
	};
}

/**
 * Check a run's own `defaults`, which arrive through the tool and so
 * are held to the same rules as a layer in the file.
 */
export function readRunDefaults(
	value: unknown,
): { settings: JobSettings } | { error: string } {
	return readSettings(value, "defaults");
}

/** Why a fleet this size is refused, or nothing when it fits. */
export function oversized(
	jobs: number,
	config: FleetConfig,
	path: string,
): string | undefined {
	if (jobs <= config.maxJobs) return undefined;
	return `This fleet would run ${jobs} subagents and the most a fleet may run is ${config.maxJobs}. Ask fewer, each for an angle the others do not cover, or raise ${SUBAGENT_SLUG}.maxJobs in ${path} if a fleet this size is what you mean.`;
}

/** Fill one job's settings from every layer, first match winning. */
export function settleJob(
	job: JobSettings,
	config: FleetConfig,
	place: FleetPlace,
): SettledJob {
	const layers: ReadonlyArray<[Layer, JobSettings | undefined]> = [
		["job", job],
		["run", place.run],
		[
			"quest",
			place.quest === undefined ? undefined : config.quests[place.quest],
		],
		[
			"project",
			place.project === undefined ? undefined : config.projects[place.project],
		],
		["config", config.defaults],
		[
			"session",
			place.sessionModel === undefined
				? undefined
				: { model: place.sessionModel },
		],
		["built-in", { thinkingLevel: DEFAULT_THINKING }],
	];
	/** The first layer that sets `field`, and what it sets it to. */
	const first = <F extends keyof JobSettings>(
		field: F,
	): { value: JobSettings[F]; layer: Layer } | undefined => {
		for (const [layer, settings] of layers) {
			const value = settings?.[field];
			if (value !== undefined) return { value, layer };
		}
		return undefined;
	};
	const model = first("model");
	const thinking = first("thinkingLevel");
	const tools = first("tools");
	const timeout = first("timeoutMs");
	const idle = first("idleTimeoutMs");
	return {
		...(model ? { model: model.value, modelFrom: model.layer } : {}),
		...(thinking ? { thinkingLevel: thinking.value } : {}),
		...(tools ? { tools: tools.value } : {}),
		...(timeout ? { timeoutMs: timeout.value } : {}),
		...(idle ? { idleTimeoutMs: idle.value } : {}),
		thinkingFrom: thinking?.layer ?? "built-in",
	};
}

/** What a layer is called in a sentence. */
const SAID: Record<Layer, string> = {
	job: "set on the job",
	run: "the run's defaults",
	quest: "the quest's settings",
	project: "the project's settings",
	config: "the config's defaults",
	session: "the session's model",
	"built-in": "the default",
};

/**
 * One line per distinct setting, saying what the jobs ran on and which
 * layer chose it, so a fleet on the wrong model is seen at once.
 */
export function describeSettled(
	jobs: ReadonlyArray<{ readonly id: string; readonly settled: SettledJob }>,
): string {
	const groups = new Map<string, string[]>();
	for (const { id, settled } of jobs) {
		const model = settled.model
			? `${settled.model} (${SAID[settled.modelFrom ?? "built-in"]})`
			: "pi's defaultModel, since nothing named one";
		const line = `${model} at ${settled.thinkingLevel} thinking (${SAID[settled.thinkingFrom]})`;
		groups.set(line, [...(groups.get(line) ?? []), id]);
	}
	const lines = [...groups.entries()];
	if (lines.length === 1) return `Ran on ${lines[0]?.[0]}.`;
	return lines.map(([line, ids]) => `${ids.join(", ")}: ${line}.`).join("\n");
}

function readKeyed(
	value: unknown,
	where: string,
): { keyed: Record<string, JobSettings> } | { error: string } {
	if (value === undefined) return { keyed: {} };
	if (!isRecord(value)) return { error: `${where} must be an object` };
	const keyed: Record<string, JobSettings> = {};
	for (const [key, entry] of Object.entries(value)) {
		const read = readSettings(entry, `${where}.${key}`);
		if ("error" in read) return read;
		keyed[key] = read.settings;
	}
	return { keyed };
}

function readSettings(
	value: unknown,
	where: string,
): { settings: JobSettings } | { error: string } {
	if (value === undefined) return { settings: {} };
	if (!isRecord(value)) return { error: `${where} must be an object` };
	const settings: {
		-readonly [F in keyof JobSettings]: JobSettings[F];
	} = {};
	if (value.model !== undefined) {
		if (typeof value.model !== "string" || value.model.length === 0) {
			return { error: `${where}.model must be a model id` };
		}
		settings.model = value.model;
	}
	if (value.thinkingLevel !== undefined) {
		if (
			typeof value.thinkingLevel !== "string" ||
			!isThinkingLevel(value.thinkingLevel)
		) {
			return { error: `${where}.thinkingLevel must be a level pi takes` };
		}
		settings.thinkingLevel = value.thinkingLevel;
	}
	if (value.tools !== undefined) {
		if (!isNameList(value.tools)) {
			return { error: `${where}.tools must be a list of tool names` };
		}
		settings.tools = value.tools;
	}
	for (const clock of ["timeoutMs", "idleTimeoutMs"] as const) {
		const ms = value[clock];
		if (ms === undefined) continue;
		if (!isWholeNumber(ms) || ms < MIN_CLOCK_MS || ms > MAX_CLOCK_MS) {
			return {
				error: `${where}.${clock} must be whole milliseconds between ${MIN_CLOCK_MS} and ${MAX_CLOCK_MS}`,
			};
		}
		settings[clock] = ms;
	}
	return { settings };
}

/** The clocks the tool schema allows a job, held to the same bounds here. */
const MIN_CLOCK_MS = 1000;
const MAX_CLOCK_MS = 8 * 60 * 60 * 1000;

function isWholeNumber(value: unknown): value is number {
	return Number.isInteger(value);
}

function isNameList(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((name) => typeof name === "string")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
