/**
 * The soak at its smallest: two conversations of two turns each through
 * one host and through plain pi, with no parking, so a change that breaks
 * the soak is found by test:host rather than on the night a week's run is
 * due. Its other cases are files of their own beside it (soak-parked,
 * soak-burst, soak-mid and soak-door), so a parallel host lane runs them
 * side by side. A week's run goes on a lent builder by hand, as README.md
 * says.
 */
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import {
	RUN_MS,
	saidAfter,
	soaked,
	soakOut,
	soakPackageDir,
} from "./soaked.ts";

const packageDir = soakPackageDir();
const out = soakOut("plain");

describe.skipIf(!packageDir)(
	"the soak (needs a pi with the host's patches: pnpm test:host)",
	() => {
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
				expect(
					report,
					"each side's start on a cold cache, said apart from the opening",
				).toMatchObject({
					coldOpen: {
						hosted: {
							ms: expect.any(Number),
							loopMaxMs: expect.any(Number),
						},
						plainMs: expect.any(Number),
					},
				});
				expect(said, "a line says the cold open").toMatch(
					/cold open \d+ ms, loop max \d+ ms/,
				);
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
