/**
 * Joel's `pineapple stop all`, before a demo, as two conversations in
 * one sealed host meet it: the stop on everything his command writes
 * parks both within a minute, the one busy in a run the harness started
 * once its tool has run out and the idle one as it stands. While it stands, a peer's
 * question gets no answer from the parked one, and a spawn asked for in
 * words Joel typed is refused, since a parked session must not start
 * more agents to carry on for it. Once he resumes, the one whose run
 * the stop ended carries on, told so, and the idle one stays idle.
 *
 * The stop is written where core's pineapple writes one, and resumed as
 * its `pineapple resume all` marks it, so this needs no pineapple. Runs
 * on the host's pi, as support/host-pi.ts finds it, skipped saying why
 * without one.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { automatedHeader } from "../../../lib/internal/automated.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	steerInbox,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import {
	SCRIPTED,
	WAIT_A_WHILE,
	WAITED,
	WAITING,
} from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** How long Joel's stop all waits for every session to park. */
const PARKING_MS = 60_000;
/** How long a parked session is given to start a run it must not. */
const NOTHING_STARTS_MS = 15_000;
/** What a tool call answers when its run was ended before it ran. */
const ABORTED = "Operation aborted";
/** A quest the spawn names, which the refusal comes before. */
const QUEST = "QEST-20261120-PAUSED";
/** What the resume says to the session whose run the stop ended. */
const RESUMED = "Joel resumed the safe-word stop";

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

/** Where core's pineapple keeps its stops, under the seal. */
function stops(): string {
	return join(sealed.env.XDG_STATE_HOME ?? "", "pineapple", "stops");
}

/** Write the stop on everything `pineapple stop all` writes, resumed or not. */
async function stopAll(resumed: boolean): Promise<void> {
	await mkdir(stops(), { recursive: true });
	const at = Date.now();
	const record = {
		id: "stop-all-1",
		shadow: false,
		said_by: "joel",
		where: "pineapple stop all on the test machine",
		words: "pineapple stop all",
		heard_at: at,
		by_joel: true,
		reaches: ["everything"],
		fell_back: false,
		resumed: resumed ? { at, by: "joel" } : null,
	};
	await writeFile(join(stops(), "stop-all-1.json"), JSON.stringify(record));
}

/** The sessions the harness has noted parked, by id. */
function parked(): string[] {
	try {
		return readFileSync(join(stops(), "..", "parked.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line): unknown => JSON.parse(line))
			.map((entry) => (isRecord(entry) ? String(entry.session) : ""));
	} catch {
		// Nobody parked yet: the poll asks again.
		return [];
	}
}

it(
	"parks every conversation at Joel's stop all, and starts nothing until he resumes",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			for (const folder of ["busy", "idle"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const busy = await host.open(join(sealed.home, "busy"), {
				model: SCRIPTED,
				// Not Joel's words, so the stop ends this run at its turn's end.
				first: `${automatedHeader("a job is reporting")}\n${WAIT_A_WHILE}`,
			});
			const idle = await host.open(join(sealed.home, "idle"), {
				model: SCRIPTED,
			});
			const files = () =>
				`busy: ${textOf(busy.file)}\nidle: ${textOf(idle.file)}`;
			await untilAnswered("the busy conversation is in its tool", async () =>
				textOf(busy.file).includes(WAITING),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${files()}`);
			});

			await stopAll(false);
			await untilAnswered(
				"both conversations park within the minute stop all waits",
				async () =>
					[busy.sessionId, idle.sessionId].every((id) => parked().includes(id)),
				PARKING_MS,
			).catch((error: unknown) => {
				throw new Error(
					`${String(error)}: parked ${JSON.stringify(parked())}\n${files()}`,
				);
			});
			expect(
				toolAnswer(busy.file, "bash"),
				"the busy one's tool ran to its end before it parked",
			).toContain(WAITED);

			await steerInbox(
				sealed,
				sessionAddress(idle.sessionId),
				`plain spawn ${QUEST}`,
			);
			await untilAnswered(
				"Joel's words to the idle one still run, and its spawn is refused",
				async () => toolAnswer(idle.file, "quest") !== undefined,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${files()}`);
			});
			expect(toolAnswer(idle.file, "quest")).toMatch(
				/safe word holds this quest spawn/,
			);
			await steerInbox(
				sealed,
				sessionAddress(idle.sessionId),
				`ping ${sessionAddress(busy.sessionId)}`,
			);
			await untilAnswered(
				"the busy one is handed the idle one's question",
				async () =>
					/Mesh message \[[0-9a-f]+\] \(question\)/.test(textOf(busy.file)),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${files()}`);
			});
			// A run the question starts is ended as it starts, and a scripted
			// model can answer before that lands, so what counts is that its
			// answer never goes: the case gives it the time an answer would
			// take, then looks.
			await pause(NOTHING_STARTS_MS);
			expect(
				[undefined, ABORTED],
				`a parked conversation answered a peer's question\n${files()}`,
			).toContain(toolAnswer(busy.file, "mesh_send"));

			await stopAll(true);
			await untilAnswered(
				"the one whose run the stop ended carries on, told Joel resumed",
				async () => textOf(busy.file).includes(RESUMED),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${files()}`);
			});
			expect(
				textOf(idle.file),
				"the one the stop found idle is left idle by the resume",
			).not.toContain(RESUMED);
		});
	},
	// A host's start, two opens, a tool that waits, a minute's parking,
	// the time given to a run that mustn't start, and the resume.
	ROUND_TRIP_MS * 4,
);
