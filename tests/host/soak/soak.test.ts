/**
 * The soak itself, at its smallest: two conversations of two turns each
 * through one host and through plain pi, with no parking, so a change
 * that breaks the soak is found by test:host rather than on the night a
 * week's run is due. A week's run goes on a lent builder by hand, as
 * README.md says.
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

describe.skipIf(!packageDir)(
	"the soak (needs a pi with the host's patches: pnpm test:host)",
	() => {
		afterAll(() => rmSync(out, { recursive: true, force: true }));

		it(
			"takes every turn on both sides, answers each, and reports",
			async () => {
				const child = spawn(
					process.execPath,
					[
						"--no-warnings",
						SOAK,
						"--turns",
						"2,2",
						"--checkpoints",
						"1",
						"--no-park",
						"--out",
						out,
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
					readFileSync(join(out, "report.json"), "utf8"),
				);
				expect(report, said).toMatchObject({
					conversations: 2,
					turns: 4,
					faults: [],
					latency: { hosted: { count: 4 }, plain: { count: 4 } },
				});
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

/** The JSON a soak line opening with `lead` holds, or undefined when no line does. */
function saidAfter(said: string, lead: string): unknown {
	const line = said
		.split("\n")
		.map((one) => one.replace(/^soak \S+ /, ""))
		.reverse()
		.find((one) => one.startsWith(lead));
	return line === undefined ? undefined : JSON.parse(line.slice(lead.length));
}
