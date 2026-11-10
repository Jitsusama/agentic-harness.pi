/**
 * E8: the launcher's Stop and Close on a hosted row, which reach the
 * conversation as steers (core #2827) that mesh-workflow's pausing.ts
 * turns into an abort and an /exit inside it. A Stop sent to a
 * conversation busy in a long tool ends that run alone: its tool is cut
 * short, the conversation stays open and answers its next words, and its
 * neighbour in the same host answers throughout. A Close then ends that
 * conversation alone: the host drops it from its list and keeps the
 * other, which still answers.
 *
 * The steers are written into the inbox as the launcher writes them, so
 * this needs no mycelium node. Runs on the host's pi, as
 * support/host-pi.ts finds it, skipped saying why without one.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import {
	type HostProcess,
	type Opening,
	startHost,
} from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	steerInbox,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import { DAWDLE, DAWDLING, SCRIPTED } from "./support/scripted-model.ts";
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

/** What the host wrote, for a failure. */
function said(): string {
	return `The host wrote:\n${host?.errors()}`;
}

/** Talk to `one` and wait until it answers, failing with its file. */
async function answers(one: SessionIdentity, what: string): Promise<void> {
	const word = `hello-${randomUUID()}`;
	const before = repliesIn(one.file);
	await steerInbox(sealed, sessionAddress(one.sessionId), word);
	await untilAnswered(
		what,
		async () => textOf(one.file).includes(word) && repliesIn(one.file) > before,
	).catch((error: unknown) => {
		throw new Error(`${String(error)}\n${textOf(one.file)}`);
	});
}

/** The conversations the host holds, by session id. */
async function held(): Promise<string[]> {
	return ((await host?.list()) ?? []).map((one) => one.sessionId);
}

it(
	"E8: a Stop ends only a busy conversation's run, and a Close only it",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const opening: Opening = { model: SCRIPTED };
			const a = await host.open(join(sealed.home, "a"), {
				...opening,
				first: DAWDLE,
			});
			const b = await host.open(join(sealed.home, "b"), opening);
			const at = sessionAddress(a.sessionId);

			await untilAnswered(
				"the first conversation is busy in its tool",
				async () => textOf(a.file).includes(DAWDLING),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(a.file)}`);
			});
			await answers(b, "the second answers while the first is busy");

			await steerInbox(sealed, at, "", "stop");
			await untilAnswered(
				"the Stop cuts the first's tool short",
				async () => toolAnswer(a.file, "bash") !== undefined,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(a.file)}`);
			});
			expect(toolAnswer(a.file, "bash")).toMatch(/Command aborted/);
			expect(await held()).toEqual(
				expect.arrayContaining([a.sessionId, b.sessionId]),
			);
			await answers(a, "the stopped conversation still listens");
			await answers(b, "the second answers after the Stop");

			await steerInbox(sealed, at, "", "close");
			await untilAnswered("the host drops the closed one alone", async () => {
				const now = await held();
				return !now.includes(a.sessionId) && now.includes(b.sessionId);
			}).catch(async (error: unknown) => {
				throw new Error(
					`${String(error)}: ${JSON.stringify(await held())}\na: ${textOf(a.file)}`,
				);
			});
			await answers(b, "the second answers after the Close");
		});
	},
	// A host's start, two opens, a Stop, a Close and four round trips.
	ROUND_TRIP_MS * 4,
);
