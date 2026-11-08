/**
 * Carrying a session's work when the person steers it to: its trees, as
 * the work broker's records hold them for it, and its file, into its
 * quest's handover, through real git.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CarriedContext,
	carryThisSession,
} from "../../../extensions/mesh-workflow/carrying.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import {
	handoverOf,
	readHandover,
} from "../../../lib/internal/carry/handover.ts";
import { thisMachine } from "../../../lib/internal/machine.ts";
import { sessionRegistryDir } from "../../../lib/internal/quest/loaded.ts";
import { questWorkspacesRoot } from "../../../lib/internal/quest/workspace-root.ts";
import { treeRecordDir } from "../../../lib/internal/work-records.ts";
import {
	bareOrigin,
	cloneAt,
	folder,
	removeAll,
} from "../../lib/internal/carry/support/machines.ts";

const made: string[] = [];
afterEach(() => removeAll(made));

const QUEST = "QEST-20261107-CARRY2";

/** A session as carrying reads it, idle once `busyFor` looks have passed. */
function session(
	id: string,
	cwd: string,
	file: string,
	busyFor = 0,
): CarriedContext {
	let looks = 0;
	return {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file,
			getSessionName: () => "Carry me",
			getCwd: () => cwd,
		} as unknown as CarriedContext["sessionManager"],
		isIdle: () => looks++ >= busyFor,
		hasUI: false,
		ui: {} as CarriedContext["ui"],
	};
}

/** The quest workflow's record of `id` working on `quest`. */
function loaded(id: string, quest: string): void {
	mkdirSync(sessionRegistryDir(), { recursive: true });
	writeFileSync(
		join(sessionRegistryDir(), `${id}.json`),
		JSON.stringify({
			sessionId: id,
			instanceId: "i-1",
			cwd: "/home/joel",
			quest,
			openedAt: "2026-11-07T20:00:00.000Z",
		}),
	);
}

describe("carrying a steered session's work", () => {
	it("puts the trees it holds and its file in its quest's handover, once its run ends", async () => {
		const home = folder(made, "home");
		const tree = await cloneAt(
			await bareOrigin(made),
			join(home, "src", "app"),
		);
		createTreeMemory(treeRecordDir()).remember({
			identity: { key: "app-carry", shareable: false },
			path: tree,
			providerId: "git",
			sessions: ["s-carry"],
		});
		loaded("s-carry", QUEST);
		const file = join(folder(made, "sessions"), "2026-11-07_s-carry.jsonl");
		writeFileSync(file, '{"type":"session","id":"s-carry"}\n');

		const done = await carryThisSession(
			session("s-carry", tree, file, 2),
			"penelope",
			{
				home,
			},
		);

		const into = handoverOf(questWorkspacesRoot(), QUEST, thisMachine());
		expect(done).toBe(join(into, "s-carry.done.json"));
		expect(readHandover(done)).toMatchObject({
			session: "s-carry",
			quest: QUEST,
			cwd: "~/src/app",
			title: "Carry me",
			sessionFile: "2026-11-07_s-carry.jsonl",
			trees: [{ path: "~/src/app", branch: "main" }],
		});
	});

	it("refuses with no quest loaded, having no handover to carry into", async () => {
		const home = folder(made, "home");

		await expect(
			carryThisSession(
				session("s-questless", home, join(home, "none.jsonl")),
				"penelope",
				{
					home,
				},
			),
		).rejects.toThrow("no quest is loaded");
	});

	it("gives up when its run never winds down", async () => {
		const home = folder(made, "home");

		await expect(
			carryThisSession(
				session("s-busy", home, "", Number.POSITIVE_INFINITY),
				"penelope",
				{
					home,
					windDownMs: 50,
				},
			),
		).rejects.toThrow("didn't end");
	});
});
