/**
 * The model and thinking level a session ran on, carried across its
 * rollover.
 *
 * pi's switch builds the fresh session and restores its model before
 * the fresh extensions have started. When the model's provider is one
 * an extension registers and pi can't find it then, the fresh session
 * comes up on no model at all: pi's placeholder, whose provider is
 * "unknown", and its next call fails with "Unknown provider: unknown".
 * Four sessions came up that way on 2026-10-31, though opening their
 * logs afresh restored the model, so what kept it from pi then is not
 * known. Whatever it was, the rollover sets the model back itself.
 *
 * The old runtime leaves what it ran on here; the fresh one, once its
 * extensions have started, takes it and sets it back. A switch
 * evaluates every extension again, so nothing in a module survives it;
 * a `Symbol.for` key on `globalThis` does, since the process stays.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A thinking level as pi names it. */
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** What a session ran on, for the log it rolled over into. */
export interface CarriedModel {
	/** The fresh log the session switched to. */
	readonly path: string;
	/** The model's provider, as pi names it. */
	readonly provider: string;
	/** The model's id within its provider. */
	readonly modelId: string;
	/** The thinking level the session ran at. */
	readonly thinkingLevel: ThinkingLevel;
}

/** pi's name for the provider of the placeholder model, which has none. */
export const NO_PROVIDER = "unknown";

const SLOT_KEY = Symbol.for("agentic-harness.rollover.carried-model");

type SlotGlobal = { [SLOT_KEY]?: CarriedModel };

/**
 * Whether a session is on no model it could answer with: none, or
 * pi's placeholder.
 */
export function hasNoModel(model: { provider: string } | undefined): boolean {
	return !model || model.provider === NO_PROVIDER;
}

/**
 * Leave what a session runs on for the log it is switching to. A
 * session on no model carries nothing, so the fresh one is left to pi.
 */
export function carryModel(carried: CarriedModel): void {
	const global = globalThis as SlotGlobal;
	if (hasNoModel({ provider: carried.provider })) {
		delete global[SLOT_KEY];
		return;
	}
	global[SLOT_KEY] = carried;
}

/** The model a log chose last, and the thinking level it set last. */
export interface ChosenModel {
	/** The model's provider, as pi names it. */
	readonly provider: string;
	/** The model's id within its provider. */
	readonly modelId: string;
	/** The thinking level, when the log ever set one. */
	readonly thinkingLevel?: ThinkingLevel;
}

const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value);
}

/**
 * The model a branch of a log last chose, and the thinking level it
 * last set, read from its `model_change` and `thinking_level_change`
 * entries. The log stays right when a running session loses its model,
 * so it is what a session on no model is set back to. Answers nothing
 * when the branch never chose a model.
 */
export function modelOfBranch(
	branch: readonly object[],
): ChosenModel | undefined {
	let chosen: { provider: string; modelId: string } | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	for (const entry of branch) {
		if (!("type" in entry)) continue;
		if (
			entry.type === "model_change" &&
			"provider" in entry &&
			"modelId" in entry &&
			typeof entry.provider === "string" &&
			typeof entry.modelId === "string" &&
			!hasNoModel({ provider: entry.provider })
		) {
			chosen = { provider: entry.provider, modelId: entry.modelId };
		}
		if (
			entry.type === "thinking_level_change" &&
			"thinkingLevel" in entry &&
			isThinkingLevel(entry.thinkingLevel)
		) {
			thinkingLevel = entry.thinkingLevel;
		}
	}
	if (!chosen) return undefined;
	return thinkingLevel ? { ...chosen, thinkingLevel } : chosen;
}

/**
 * Take what was carried for the log at `path`, leaving nothing behind.
 * Answers nothing when nothing was carried, or it was for another log:
 * a carry the switch never reached is no one's to take.
 */
export function takeCarriedModel(
	path: string | undefined,
): CarriedModel | undefined {
	const global = globalThis as SlotGlobal;
	const carried = global[SLOT_KEY];
	delete global[SLOT_KEY];
	if (!carried || !path || carried.path !== path) return undefined;
	return carried;
}
