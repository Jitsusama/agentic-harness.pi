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
			},
			RUN_MS,
		);
	},
);
