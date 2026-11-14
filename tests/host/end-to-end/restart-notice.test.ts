/**
 * E25: a host that restarts itself mid-run carries each run on in the
 * next host, and a conversation whose run it carried is told nothing
 * more of the restart. One whose job died with it is told of that job
 * alone, and not that nothing resumed it. On 14 November the 08:37
 * restart carried a run to its end and then told it nothing had resumed
 * it, to rerun what mattered, which cost a turn; the soak's mid-run
 * restart showed the same notice in every run (SEYNT2).
 *
 * Both conversations are mid-tool as the first host stops. Every job the
 * scripted model starts carries through a restart, a bash call or a
 * fleet, so the job that died is one the second conversation's log is
 * given while no host runs, as a host's own record names one. Its notice
 * is also the witness that the next host has said what it will say.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { saidAfter } from "./support/held-pi.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { SCRIPTED, WAIT_A_WHILE, WAITING } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** The record job-workflow leaves when a session's end cuts work off. */
const CUT_OFF_ENTRY = "job-session-cut-off";

/** What the notice of a cut-off says, whatever was cut off. */
const NOTICE = "the machine ended this session";

/** The job named dead in the second conversation's log. */
const DEAD = { id: "j9", label: "watch the gate" };

/**
 * How long past the witness's notice the first conversation is watched
 * for one of its own: the next host posts both as each conversation
 * starts, so a notice for the first lands within seconds of the second's.
 */
const NOTICE_GRACE_MS = 15_000;

let sealed: Seal;
let hosts: HostProcess[] = [];
beforeEach(async () => {
	sealed = await seal();
	hosts = [];
});
afterEach(async () => {
	for (const host of hosts) await host.kill();
	await sealed.dispose();
});

/** What every host started here wrote, for a failure. */
function said(): string {
	return hosts
		.map((host, at) => `Host ${at + 1} wrote:\n${host.errors()}`)
		.join("\n");
}

/** A host under the seal, kept to be killed after. */
async function start(pi: string): Promise<HostProcess> {
	const host = await startHost({
		seal: sealed,
		engine: PI_ENGINE,
		kind: "background",
		env: { PI_HOST_PACKAGE_DIR: pi },
	});
	hosts.push(host);
	return host;
}

/** Open a conversation in a folder of its own, mid-tool once this answers. */
async function midTool(host: HostProcess, folder: string): Promise<string> {
	const cwd = join(sealed.home, folder);
	await mkdir(cwd, { recursive: true });
	const one = await host.open(cwd, { model: SCRIPTED, first: WAIT_A_WHILE });
	const file = one.file ?? "";
	await untilAnswered(
		`${folder}'s tool to start`,
		async () => textOf(file).includes(WAITING),
		ROUND_TRIP_MS,
	);
	if (turnEnded(file))
		throw new Error(`${folder}'s turn ended before the restart; ${said()}`);
	return file;
}

/** The entries of a session's log, as JSON. */
function entriesOf(file: string): Record<string, unknown>[] {
	return textOf(file)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line): unknown => JSON.parse(line))
		.filter(isRecord);
}

/** The cut-off records a session's log holds. */
function cutOffsIn(file: string): unknown[] {
	return entriesOf(file)
		.filter((entry) => entry.customType === CUT_OFF_ENTRY)
		.map((entry) => entry.data);
}

/** Give a log a host's record of a job that died, at its end. */
async function deadJobIn(file: string): Promise<void> {
	const last = entriesOf(file).at(-1);
	const entry = {
		type: "custom",
		customType: CUT_OFF_ENTRY,
		id: randomBytes(4).toString("hex"),
		parentId: typeof last?.id === "string" ? last.id : null,
		timestamp: new Date().toISOString(),
		data: { at: Date.now(), running: true, runCarried: true, jobs: [DEAD] },
	};
	await appendFile(file, `${JSON.stringify(entry)}\n`);
}

it(
	"E25: a host's restart carries each run on, and tells its conversation only of a job that died",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const first = await start(pi);
			// Opened together, so both are mid-tool within its 20 s.
			const [carried, witness] = await Promise.all([
				midTool(first, "carried"),
				midTool(first, "witness"),
			]);

			await first.restart();
			expect(
				cutOffsIn(carried),
				"the stopping host records the run it carries as carried",
			).toEqual([expect.objectContaining({ running: true, runCarried: true })]);
			const held = textOf(carried).length;
			await deadJobIn(witness);
			const witnessHeld = textOf(witness).length;

			const second = await start(pi);
			await untilAnswered(
				"the next host resumes both",
				async () => (await second.list()).length === 2,
				ROUND_TRIP_MS,
			);
			await untilAnswered(
				"the carried run ends in the next host",
				async () => saidAfter(carried, held).length > 0 && turnEnded(carried),
				ROUND_TRIP_MS,
			).catch((failed: unknown) => {
				throw new Error(`${String(failed)}\n${said()}`);
			});
			await untilAnswered(
				"the witness is told of its dead job",
				async () => saidAfter(witness, witnessHeld).includes(NOTICE),
				ROUND_TRIP_MS,
			).catch((failed: unknown) => {
				throw new Error(
					`${String(failed)}\nsaid: ${saidAfter(witness, witnessHeld)}\n${said()}`,
				);
			});
			const told = saidAfter(witness, witnessHeld);
			expect(told, "the notice names the job that died").toContain(
				`${DEAD.id} (${DEAD.label})`,
			);
			expect(told, "and says its host carried the run on").toContain(
				"carried on the run",
			);
			expect(told, "and never that nothing resumed it").not.toMatch(
				/mid-run|nothing has resumed it/,
			);

			const late = await untilAnswered(
				"the carried conversation is told of the restart",
				async () => saidAfter(carried, held).includes(NOTICE),
				NOTICE_GRACE_MS,
			).then(
				() => true,
				() => false,
			);
			expect(
				late,
				`a conversation whose run was carried on is told nothing more; said: ${saidAfter(carried, held)}`,
			).toBe(false);
		});
	},
	ROUND_TRIP_MS * 6 + NOTICE_GRACE_MS,
);
