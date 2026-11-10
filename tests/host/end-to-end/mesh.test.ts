/**
 * E1: two conversations in one sealed host play ping-pong over the mesh,
 * each through this harness's own mesh tools, on H1's engine and pi's own
 * runtime with a scripted model. One is told to ping the other's address;
 * the other is handed the question as a mesh message, which starts its
 * turn, and answers pong; the answer starts the first's turn again.
 *
 * Runs on a pi built with the host's patches, found as support/host-pi.ts
 * says; without one it is skipped saying how to get one, since an
 * ordinary check can't build the host's runtime. `pnpm test:host` runs it
 * and fails instead.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	untilAnswered,
} from "./support/hosted-case.ts";
import { SCRIPTED } from "./support/pi-engine.ts";
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

it(
	"E1: plays ping-pong between two conversations in one host",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });

			const b = await host.open(join(sealed.home, "b"), { model: SCRIPTED });
			const a = await host.open(join(sealed.home, "a"), {
				model: SCRIPTED,
				first: `ping ${sessionAddress(b.sessionId)}`,
			});

			await untilAnswered("the first conversation hears pong", async () =>
				textOf(a.file).includes("pong heard"),
			).catch((error: unknown) => {
				throw new Error(
					`${String(error)}\na: ${textOf(a.file)}\nb: ${textOf(b.file)}`,
				);
			});
			expect(textOf(b.file)).toMatch(/Mesh message \[[0-9a-f]+\] \(question\)/);
			expect(textOf(b.file)).toContain('"text":"pong"');
		});
	},
	// The host's start, two opens and the round trip.
	ROUND_TRIP_MS * 2,
);
