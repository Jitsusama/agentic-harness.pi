/**
 * E14: a plain spawn lands in the host spawnHost names whatever code its
 * spawner ran (OSPHT4 [331aca88]). A spawner on code from before the
 * setting hands the launcher a session as it always did: first words
 * left under a fresh id, and a window whose pi starts with
 * `--session-id` and the quest to load. Here that pi starts in a
 * terminal of its own as the launcher's window starts it, with the
 * words already left, under spawnHost "background". It ends before it
 * draws anything, so its holder would close the window with no frame in
 * it; the background host lists a conversation in its folder whose log
 * holds those words and a reply, and the words are recorded as taken by
 * that conversation, which is how the old spawner's look for its first
 * turn finds it started rather than opening it again.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { leaveFirstWords } from "../../../lib/internal/quest/first-words.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	textOf,
	untilAnswered,
} from "./support/hosted-case.ts";
import { sealQuest } from "./support/quests.ts";
import { type Seal, seal } from "./support/seal.ts";
import { runTerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** The quest the spawn is for. */
const QUEST = "QEST-20261112-L4UNCH";

/** How long the launched pi may take to load the harness and hand itself on. */
const HAND_MS = 120_000;

let sealed: Seal;
let host: HostProcess | undefined;
let ran = "";
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	ran = "";
});
afterEach(async () => {
	await host?.kill();
	await sealed.dispose();
});

/** What the host and the launched pi wrote, for a failure. */
function said(): string {
	return [
		host ? `The host wrote:\n${host.errors()}` : "",
		ran ? `The launched pi wrote:\n${ran}` : "",
	].join("\n");
}

/** The harness's folder for `slug` under the seal's `variable`. */
function harnessFolder(variable: string, slug: string): string {
	return join(sealed.env[variable] ?? "", "pi", "agentic-harness.pi", slug);
}

it(
	"E14: a spawn's window from a spawner on old code hands its pi to the background host before it draws",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			await sealQuest(sealed, { id: QUEST, title: "Be launched" });
			const config = join(
				sealed.env.XDG_CONFIG_HOME ?? "",
				"pi",
				"agentic-harness.pi",
			);
			await mkdir(config, { recursive: true });
			await writeFile(
				join(config, "config.json"),
				JSON.stringify({
					version: 1,
					sections: { "quest-workflow": { spawnHost: "background" } },
				}),
			);
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			const cwd = join(sealed.home, "w");
			await mkdir(cwd, { recursive: true });
			// Trusted as Joel's own folders are, so no question comes first.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			// What the old spawner leaves before it hands the launcher the id.
			const launched = randomUUID();
			const words = `Carry on with ${QUEST}. ${randomUUID()}`;
			const firstWords = harnessFolder("XDG_STATE_HOME", "quest-workflow");
			leaveFirstWords(launched, words, join(firstWords, "first-words"));

			const ended = await runTerminalPi({
				seal: sealed,
				packageDir: pi,
				cwd,
				env: { QUEST_WORKFLOW_AUTOLOAD_ID: QUEST },
				args: ["--session-id", launched],
				withinMs: HAND_MS,
			});
			ran = ended.errors;

			expect(ended.code, "the launched pi ends cleanly").toBe(0);
			// pi warns of a fresh --session-id before any extension loads, as
			// every window the launcher opens for a spawn shows; nothing after.
			expect(
				ended.screen
					.filter((line) => !line.startsWith("Warning: No project session"))
					.join("")
					.trim(),
				"it ends before it draws a frame",
			).toBe("");
			const listed = ((await host.list()) ?? []).find((one) => one.cwd === cwd);
			expect(
				listed,
				"the host lists a conversation in its folder",
			).toBeDefined();
			await untilAnswered(
				"the hosted conversation is told the first words and answers",
				async () =>
					textOf(listed?.file).includes(words) && repliesIn(listed?.file) > 0,
				ROUND_TRIP_MS,
			);
			const taken: unknown = JSON.parse(
				readFileSync(
					join(firstWords, "first-words", `${launched}.taken`),
					"utf8",
				),
			);
			expect(taken, "the words are taken by the hosted one").toMatchObject({
				sessionId: listed?.sessionId,
				said: true,
			});
			expect(
				readFileSync(join(firstWords, "launched-spawns.log"), "utf8"),
			).toContain(`went to the ${sealed.realm}-background host`);
		});
	},
	ROUND_TRIP_MS * 2 + HAND_MS,
);
