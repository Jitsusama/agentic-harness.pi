/**
 * Quests sealed into a seal's quest store, as the checks that open a
 * conversation on a quest need them: a README with the front matter
 * quest-workflow reads, under the seal's XDG_DATA_HOME.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seal } from "./seal.ts";

/** What a sealed quest says of itself, beyond being active. */
export interface SealedQuest {
	readonly id: string;
	readonly title: string;
	/** The quest it sits under, making it a subquest. */
	readonly parent?: string;
	/** The budget it draws on, by name. */
	readonly budget?: string;
	/** Whether the session that loads it orchestrates the quests under it. */
	readonly orchestrator?: boolean;
}

/** The harness's folder under one of the seal's XDG folders. */
export function harnessUnder(
	seal: Seal,
	variable: "XDG_CONFIG_HOME" | "XDG_DATA_HOME",
): string {
	return join(seal.env[variable] ?? "", "pi", "agentic-harness.pi");
}

/** Write `quest` into the seal's quest store. */
export async function sealQuest(seal: Seal, quest: SealedQuest): Promise<void> {
	const folder = join(
		harnessUnder(seal, "XDG_DATA_HOME"),
		"quest-workflow",
		"quests",
		quest.id,
	);
	await mkdir(folder, { recursive: true });
	await writeFile(
		join(folder, "README.md"),
		[
			"---",
			`id: ${quest.id}`,
			`kind: ${quest.parent ? "subquest" : "quest"}`,
			"status: active",
			"priority: active",
			"rank: 1",
			`parent: ${quest.parent ?? "null"}`,
			"started: 2026-11-09",
			"updated: 2026-11-09",
			...(quest.budget ? [`budget: ${quest.budget}`] : []),
			...(quest.orchestrator ? ["orchestrator: true"] : []),
			"---",
			`# ${quest.title}`,
			"",
		].join("\n"),
	);
}
