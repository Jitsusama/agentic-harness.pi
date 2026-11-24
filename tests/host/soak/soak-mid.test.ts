/**
 * The soak at ten turns a conversation, which takes every kind of turn (a
 * steer, an abort and a compaction among them) through a planned restart
 * mid-run, carrying the turn it cut off to its answer.
 */
import { describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { RUN_MS, soaked, soakOut, soakPackageDir } from "./soaked.ts";

const packageDir = soakPackageDir();
const out = soakOut("mid");

describe.skipIf(!packageDir)(
	"the soak, restarted mid-run (needs a pi with the host's patches: pnpm test:host)",
	() => {
		it(
			"steers, aborts and compacts on both sides, and carries a turn the restart cut off to its answer",
			async () => {
				const { said, report } = await soaked(
					out,
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
					`each conversation's record matches plain pi's past what differs on every run: ${JSON.stringify(isRecord(report) ? report.parity : undefined)}`,
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
