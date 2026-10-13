/**
 * The step between a fleet being asked for and its jobs being built:
 * read the config, refuse a fleet over the cap, and fill each job's
 * settings from the layers in `sizing.ts`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPackageConfig } from "../../lib/internal/config/loader.ts";
import { packageConfigPath } from "../../lib/internal/paths.ts";
import { fleetPlace } from "./place.ts";
import type { ToolJobInput } from "./run.ts";
import {
	describeSettled,
	oversized,
	readFleetConfig,
	readRunDefaults,
	SUBAGENT_SLUG,
	settleJob,
} from "./sizing.ts";

/** The jobs as they will run, and the line saying what they run on. */
export type SizedFleet =
	| { readonly jobs: ToolJobInput[]; readonly ranOn: string }
	| { readonly refusal: string };

/** Size a fleet: its cap, then every job's settings. */
export async function sizeFleet(
	ctx: ExtensionContext,
	jobs: readonly ToolJobInput[],
	runDefaults: unknown,
): Promise<SizedFleet> {
	const path = packageConfigPath();
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) return { refusal: loaded.error };
	const read = readFleetConfig(loaded.config.sections[SUBAGENT_SLUG], path);
	if (!read.ok) return { refusal: read.error };
	const tooMany = oversized(jobs.length, read.config, path);
	if (tooMany) return { refusal: tooMany };
	const run = readRunDefaults(runDefaults);
	if ("error" in run) return { refusal: run.error };

	const place = await fleetPlace(ctx, run.settings);
	const settled = jobs.map((job) => ({
		job,
		settled: settleJob(job, read.config, place),
	}));
	return {
		jobs: settled.map(({ job, settled: s }) => ({
			...job,
			...(s.model === undefined ? {} : { model: s.model }),
			...(s.thinkingLevel === undefined
				? {}
				: { thinkingLevel: s.thinkingLevel }),
			...(s.tools === undefined ? {} : { tools: s.tools }),
			...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
			...(s.idleTimeoutMs === undefined
				? {}
				: { idleTimeoutMs: s.idleTimeoutMs }),
		})),
		ranOn: describeSettled(
			settled.map(({ job, settled: s }) => ({ id: job.id, settled: s })),
		),
	};
}

/** The same answer with `line` said before the rest of its text. */
export function saidFirst<
	T extends { content: ReadonlyArray<{ type: "text"; text: string }> },
>(line: string, answer: T): T {
	return {
		...answer,
		content: answer.content.map((part, index) =>
			index === 0 ? { ...part, text: `${line}\n${part.text}` } : part,
		),
	};
}
