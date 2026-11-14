/**
 * The soak itself, at its smallest: two conversations of two turns each
 * through one host and through plain pi, once with no parking, once
 * parked and woken in turn, and once parked and woken in a burst and
 * then through a host restart, so a change that breaks the soak is found by
 * test:host rather than on the night a week's run is due. And once at ten
 * turns each, which takes every kind of turn (a steer, an abort and a
 * compaction among them) through a planned restart mid-run. A week's run
 * goes on a lent builder by hand, as README.md says.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	HOST_PI_REQUIRED,
	hostPackageDir,
	hostPiMissing,
} from "../end-to-end/support/host-pi.ts";

const packageDir = hostPackageDir();
if (!packageDir && process.env[HOST_PI_REQUIRED])
	throw new Error(hostPiMissing());

const SOAK = resolve(import.meta.dirname, "soak.mts");
/** Two sides each loading every extension, on a loaded machine. */
const RUN_MS = 600_000;
const out = mkdtempSync(join(tmpdir(), "soak-"));
const parkedOut = mkdtempSync(join(tmpdir(), "soak-parked-"));
const burstOut = mkdtempSync(join(tmpdir(), "soak-burst-"));
const midOut = mkdtempSync(join(tmpdir(), "soak-mid-"));

describe.skipIf(!packageDir)(
	"the soak (needs a pi with the host's patches: pnpm test:host)",
	() => {
		afterAll(() => {
			rmSync(out, { recursive: true, force: true });
			rmSync(parkedOut, { recursive: true, force: true });
		});

		it(
			"takes every turn on both sides, answers each, and reports",
			async () => {
				const { said, report } = await soaked(out, ["--no-park"]);
				expect(report, said).toMatchObject({
					conversations: 2,
					turns: 4,
					faults: [],
					latency: { hosted: { count: 4 }, plain: { count: 4 } },
				});
				expect(
					isRecord(report) ? report.latency : undefined,
					"each turn and each of its steps paired with plain pi's, each key's prompt seen drawn",
				).toMatchObject({
					paired: { count: 4, unpaired: 0 },
					steps: {
						rounds: { max: expect.any(Number) },
						tools: { count: expect.any(Number) },
						turns: 4,
						unpaired: 0,
					},
					screen: { unshown: 0, burst: { unshown: 0 } },
					bar: {
						rounds: expect.any(Boolean),
						tools: expect.any(Boolean),
						keyToAccepted: expect.any(Boolean),
						keyToDrawn: expect.any(Boolean),
					},
				});
				const screen =
					isRecord(report) && isRecord(report.latency)
						? report.latency.screen
						: undefined;
				const drawnCount = (split: unknown) =>
					isRecord(split) &&
					isRecord(split.keyToDrawn) &&
					typeof split.keyToDrawn.count === "number"
						? split.keyToDrawn.count
						: 0;
				expect(
					isRecord(screen) ? drawnCount(screen) + drawnCount(screen.burst) : 0,
					"every key drawn, steady or in a burst, as unpaced both open at once",
				).toBe(4);
				expect(report, "no pace, no stagger").toMatchObject({
					staggerMs: 0,
					slowSteps: expect.any(Array),
				});
				expect(
					isRecord(report) ? report.turnsTimed : undefined,
					"every hosted turn's own times, to read again later",
				).toHaveLength(4);
				expect(
					isRecord(report) ? report.checkpoints : undefined,
					"one weighing, at the end",
				).toHaveLength(1);
				expect(
					isRecord(report) && Array.isArray(report.checkpoints)
						? report.checkpoints[0]
						: undefined,
					"the weighing holds what V8 keeps beside the heap it uses",
				).toMatchObject({
					awake: {
						heapTotalKb: expect.any(Number),
						externalKb: expect.any(Number),
						arrayBuffersKb: expect.any(Number),
					},
				});
				expect(
					isRecord(report) && Array.isArray(report.checkpoints)
						? report.checkpoints[0]
						: undefined,
					"the weighing says how late and how busy the host's loop ran since the last",
				).toMatchObject({
					awake: {
						loopP99Ms: expect.any(Number),
						loopMaxMs: expect.any(Number),
						loopBusy: expect.any(Number),
					},
				});
				expect(said, "the checkpoint line says the loop's delay").toMatch(
					/loop p99 \d+ ms, max \d+ ms, busy \d+%/,
				);
				expect(
					report,
					"the loop while they opened, apart from the checkpoint's, and the slow keys",
				).toMatchObject({
					opened: {
						ms: expect.any(Number),
						weight: { loopMaxMs: expect.any(Number) },
					},
					slowKeys: expect.any(Array),
				});
				expect(said, "a line says the opening's loop").toMatch(
					/opened all 2 in \d+ ms, loop p99 \d+ ms/,
				);
				// A lender lost before the end leaves what each line said by then.
				expect(
					saidAfter(said, "latency so far "),
					"the hosted turns' latency, said at the checkpoint",
				).toMatchObject({ hosted: { count: 4 } });
				for (const index of [0, 1])
					expect(
						saidAfter(said, `plain ${index} done `),
						`plain conversation ${index}'s latency, said as it ends`,
					).toMatchObject({ count: 2 });
			},
			RUN_MS,
		);
	},
);

describe.skipIf(!packageDir)(
	"the soak, parked (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"wakes a window's conversation on its own, timing its answer apart from its first drawing",
			async () => {
				const { said, report } = await soaked(parkedOut, []);
				expect(report, said).toMatchObject({ faults: [] });
				// At the first checkpoint the first conversation wakes by a window,
				// the second by the mesh.
				expect(
					isRecord(report) && Array.isArray(report.checkpoints)
						? report.checkpoints[0]
						: undefined,
					"the window's wake, how big its record was, and when it answered and drew",
				).toMatchObject({
					windowWakes: [
						{
							conversation: 0,
							recordBytes: expect.any(Number),
							answeredMs: expect.any(Number),
							drawnMs: expect.any(Number),
						},
					],
				});
			},
			RUN_MS,
		);
	},
);

describe.skipIf(!packageDir)(
	"the soak, woken in a burst (needs a pi with the host's patches: pnpm test:host)",
	() => {
		afterAll(() => rmSync(burstOut, { recursive: true, force: true }));

		it(
			"wakes every parked conversation by a window at once, timing each, and weighs the loop after",
			async () => {
				const { said, report } = await soaked(burstOut, [
					"--burst",
					"--restart",
				]);
				expect(report, said).toMatchObject({ faults: [] });
				const first =
					isRecord(report) && Array.isArray(report.checkpoints)
						? report.checkpoints[0]
						: undefined;
				expect(
					first,
					"both conversations' wakes, and none one at a time",
				).toMatchObject({
					burstWakes: [
						{ conversation: 0, answeredMs: expect.any(Number) },
						{ conversation: 1, answeredMs: expect.any(Number) },
					],
					windowWakes: [],
				});
				expect(first, "how late the loop ran through the burst").toMatchObject({
					afterBurst: {
						loopP99Ms: expect.any(Number),
						loopMaxMs: expect.any(Number),
					},
				});
				expect(said, "the checkpoint line says the burst").toMatch(
					/burst of 2: slowest answered \d+ ms, loop max \d+ ms/,
				);
				expect(
					isRecord(report) ? report.restart : undefined,
					"a fresh host on the same state, timed to its socket, holding both parked, then both woken at once",
				).toMatchObject({
					toSocketMs: expect.any(Number),
					parkedAtStart: 2,
					wakes: [
						{ conversation: 0, answeredMs: expect.any(Number) },
						{ conversation: 1, answeredMs: expect.any(Number) },
					],
					allAnsweredMs: expect.any(Number),
					after: { loopMaxMs: expect.any(Number) },
				});
				expect(said, "a line says the restart").toMatch(
					/restart: socket in \d+ ms, 2 of 2 parked, all answered in \d+ ms/,
				);
			},
			RUN_MS,
		);
	},
);

describe.skipIf(!packageDir)(
	"the soak, restarted mid-run (needs a pi with the host's patches: pnpm test:host)",
	() => {
		afterAll(() => rmSync(midOut, { recursive: true, force: true }));

		it(
			"steers, aborts and compacts on both sides, and carries a turn the restart cut off to its answer",
			async () => {
				const { said, report } = await soaked(
					midOut,
					["--restart-mid"],
					["10,10", "2"],
				);
				expect(report, said).toMatchObject({ turns: 20, faults: [] });
				expect(
					isRecord(report) ? report.kinds : undefined,
					"every kind of turn, counted",
				).toEqual({
					echo: 10,
					read: 1,
					bash: 1,
					steer: 2,
					job: 2,
					abort: 2,
					long: 1,
					compact: 1,
				});
				// At the first checkpoint's turn, c0-t5 is a steer, which the person
				// drives and nothing carries; c1-t5 is an echo, held as it's asked.
				expect(
					isRecord(report) ? report.restartMid : undefined,
					"a planned restart while a turn was asked, carried on to its answer",
				).toMatchObject({
					stopMs: expect.any(Number),
					toSocketMs: expect.any(Number),
					cut: ["c1-t5"],
					answered: [{ tag: "c1-t5", ms: expect.any(Number) }],
				});
				expect(said, "a line says the restart").toMatch(
					/restart mid-run: stopped in \d+ ms, socket in \d+ ms/,
				);
				expect(
					isRecord(report) ? report.latency : undefined,
					"each side's latency past the compaction, which asks nothing, and the turn cut off",
				).toMatchObject({
					hosted: { count: 18 },
					plain: { count: 18 },
					paired: { count: 18, unpaired: 0 },
				});
				expect(
					isRecord(report) && Array.isArray(report.parity)
						? report.parity.map((one) =>
								isRecord(one) ? one.unexpected : undefined,
							)
						: undefined,
					"each conversation's record matches plain pi's past what differs on every run",
				).toEqual([0, 0]);
				expect(
					isRecord(report) && Array.isArray(report.parity)
						? report.parity.map((one) =>
								isRecord(one) ? one.customsLeftOut : undefined,
							)
						: undefined,
					"only the conversation the restart cut leaves the host's own records out",
				).toEqual([undefined, true]);
			},
			RUN_MS,
		);
	},
);

/** Run a soak into `into`, the smallest unless `size` gives its turns and checkpoints: what it said and its report. */
async function soaked(
	into: string,
	extra: readonly string[],
	[turns, checkpoints]: readonly [string, string] = ["2,2", "1"],
): Promise<{ said: string; report: unknown }> {
	const child = spawn(
		process.execPath,
		[
			"--no-warnings",
			SOAK,
			"--turns",
			turns,
			"--checkpoints",
			checkpoints,
			...extra,
			"--out",
			into,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let said = "";
	child.stdout.on("data", (chunk) => {
		said += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		said += String(chunk);
	});
	const [code] = await once(child, "exit");
	expect(code, said).toBe(0);
	const report: unknown = JSON.parse(
		readFileSync(join(into, "report.json"), "utf8"),
	);
	return { said, report };
}

/** The JSON a soak line opening with `lead` holds, or undefined when no line does. */
function saidAfter(said: string, lead: string): unknown {
	const line = said
		.split("\n")
		.map((one) => one.replace(/^soak \S+ /, ""))
		.reverse()
		.find((one) => one.startsWith(lead));
	return line === undefined ? undefined : JSON.parse(line.slice(lead.length));
}
