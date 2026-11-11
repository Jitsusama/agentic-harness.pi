/**
 * A hosted conversation whose turn has ended while its background job
 * runs is listed busy, and idle once the job has ended and its result
 * is said. On 11 November a watcher outside the host read every
 * conversation listed idle for two minutes and restarted the background
 * host, which cut off a job 93XPJV had running: the list said only
 * whether a turn ran, though the host's own restart already held off for
 * the job (OSPHT4, 14:52).
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { LINGER, LINGERING, SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

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
	"lists a conversation busy while its background job runs past its turn, and idle once the job's result is said",
	async ({ skip }) => {
		await onHostPi(
			skip,
			() => host?.errors() ?? "",
			async (pi) => {
				const started = await startHost({
					seal: sealed,
					engine: PI_ENGINE,
					env: { PI_HOST_PACKAGE_DIR: pi },
				});
				host = started;
				const folder = join(sealed.home, "lingering");
				await mkdir(folder, { recursive: true });
				const one = await started.open(folder, {
					model: SCRIPTED,
					first: LINGER,
				});
				const listed = async (): Promise<SessionIdentity | undefined> =>
					(await started.list()).find(
						(held) => held.sessionId === one.sessionId,
					);
				const failing = (failed: unknown) => {
					throw new Error(
						`${String(failed)}; the log holds:\n${textOf(one.file)}\nthe host said: ${started.errors()}`,
					);
				};

				await untilAnswered(
					"the turn that started the job to end",
					async () =>
						textOf(one.file).includes(LINGERING) && turnEnded(one.file),
				).catch(failing);
				expect(
					(await listed())?.state,
					"listed while its job runs past the turn",
				).toBe("busy");

				await untilAnswered(
					"the conversation to be listed idle once its job's result is said",
					async () => (await listed())?.state === "idle",
				).catch(failing);
				expect(
					turnEnded(one.file),
					"listed idle only once the result's turn has ended",
				).toBe(true);
			},
		);
	},
	ROUND_TRIP_MS * 3,
);
