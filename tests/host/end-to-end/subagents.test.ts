/**
 * E7: subagents from a hosted conversation, as W11's done-means puts it
 * (extensions.md, W11). A conversation in a host runs a subagent call of
 * two jobs; both answer, each from a `pi --mode json` process of its
 * own, run by the host's own node on the host runtime's own CLI, not the
 * person's ordinary pi.
 *
 * Each child says its pid, node and arguments from inside itself, since
 * pi titles itself `pi`, which overwrites the command line /proc and ps
 * would show.
 *
 * Each child loads the scripted model as an extension, since a subagent
 * sees only what it is handed. Runs on the host's pi, as
 * support/host-pi.ts finds it, skipped saying why without one.
 */

import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import { SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const PROVIDER = resolve(import.meta.dirname, "support/scripted-provider.ts");

/** Each job's result file, as the subagent tool's answer cites it. */
const RESULT = /→ (\S+\/result\.json)/g;

/** What each job the answer cites said last, from its result file. */
async function jobAnswers(answer: string): Promise<string[]> {
	return Promise.all(
		[...answer.matchAll(RESULT)].map(async ([, path]) => {
			const result: unknown = JSON.parse(await readFile(path ?? "", "utf8"));
			return isRecord(result) && typeof result.finalAssistantText === "string"
				? result.finalAssistantText
				: "";
		}),
	);
}

let sealed: Seal;
let host: HostProcess | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
});
afterEach(async () => {
	await host?.kill();
	await sealed.dispose();
});

it(
	"E7: a hosted conversation's two subagents answer, each on the host's own pi",
	async ({ skip }) => {
		await onHostPi(
			skip,
			() => `The host wrote:\n${host?.errors()}`,
			async (pi) => {
				host = await startHost({
					seal: sealed,
					engine: PI_ENGINE,
					env: { PI_HOST_PACKAGE_DIR: pi },
				});
				const work = join(sealed.home, "fleet");
				await mkdir(work, { recursive: true });
				const asking = await host.open(work, {
					model: SCRIPTED,
					first: `fleet ${work} ${PROVIDER}`,
				});
				await untilAnswered(
					"both subagents answer",
					async () => toolAnswer(asking.file, "subagent") !== undefined,
					ROUND_TRIP_MS,
				).catch((error: unknown) => {
					throw new Error(`${String(error)}\n${textOf(asking.file)}`);
				});
				const answer = toolAnswer(asking.file, "subagent") ?? "";
				const cli = join(realpathSync(pi), "dist", "bundle", "cli.js");
				const ran = await jobAnswers(answer);
				const said = `${answer}\n${ran.join("\n")}`;
				expect(ran, said).toHaveLength(2);
				const pids = new Set<string>();
				for (const line of ran) {
					const [pid, node, entry, ...rest] = line.split(" ");
					pids.add(pid ?? "");
					expect(node, said).toBe(realpathSync(process.execPath));
					expect(entry, said).toBe(cli);
					expect(rest.join(" "), said).toContain("--mode json");
				}
				expect(pids.size, "two children, not one answering twice").toBe(2);
			},
		);
	},
	// The host's start, an open, and a fleet of two children's starts.
	ROUND_TRIP_MS * 3,
);
