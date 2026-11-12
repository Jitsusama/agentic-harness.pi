/**
 * E15: a hosted conversation's subagents answer on the host's gateway
 * key. A host holds no key in its own environment: its engine resolves
 * one per request. A subagent is a pi of its own, whose providers read
 * the key from the environment it starts with, as Shopify's proxy
 * extension's do, so without the host's key it refuses with "No API key
 * found" before it answers anything.
 *
 * Each child loads the scripted model on `$SHOPIFY_PROXY_KEY`
 * (support/keyed-provider.ts). Runs on the host's pi, as
 * support/host-pi.ts finds it, skipped saying why without one.
 */

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
const KEYED = resolve(import.meta.dirname, "support/keyed-provider.ts");

/** Each job's result file, as the subagent tool's answer cites it. */
const RESULT = /→ (\S+\/result\.json)/g;

/** Each job the answer cites, as its result file says it ended. */
async function jobResults(
	answer: string,
): Promise<{ state: string; said: string; stderr: string }[]> {
	return Promise.all(
		[...answer.matchAll(RESULT)].map(async ([, path]) => {
			const result: unknown = JSON.parse(await readFile(path ?? "", "utf8"));
			const text = (field: string): string =>
				isRecord(result) && typeof result[field] === "string"
					? result[field]
					: "";
			return {
				state: text("state"),
				said: text("finalAssistantText"),
				stderr: text("stderrTail"),
			};
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
	"E15: a hosted conversation's subagents answer on the host's gateway key",
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
					first: `fleet ${work} ${KEYED}`,
				});
				await untilAnswered(
					"the subagent call answers",
					async () => toolAnswer(asking.file, "subagent") !== undefined,
					ROUND_TRIP_MS,
				).catch((error: unknown) => {
					throw new Error(`${String(error)}\n${textOf(asking.file)}`);
				});
				const answer = toolAnswer(asking.file, "subagent") ?? "";
				const jobs = await jobResults(answer);
				const said = `${answer}\n${JSON.stringify(jobs, null, 2)}`;
				expect(jobs, said).toHaveLength(2);
				for (const job of jobs) {
					expect(job.stderr, said).not.toContain("No API key found");
					expect(job.state, said).toBe("complete");
					expect(job.said, said).toContain("--mode json");
				}
			},
		);
	},
	// The host's start, an open, and a fleet of two children's starts.
	ROUND_TRIP_MS * 3,
);
