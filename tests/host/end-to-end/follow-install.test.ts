/**
 * A hosted conversation follows its install as plain pi does. Its host
 * loads the harness from an install kept as pi-packages keeps one, a
 * `current` link onto a folder of versions; once the link moves onto
 * another version, the conversation's next run ends with the host
 * reloading it, and the runtime it starts says the move was its own and
 * that it runs the new version. Before, it kept the version it started
 * with until something asked it to reload.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	steerInbox,
	textOf,
	untilAnswered,
} from "./support/hosted-case.ts";
import { moveTo, version } from "./support/install.ts";
import { SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** What the reloaded runtime says, as lifecycle.ts's landedText puts it. */
const FOLLOWED = "Reloaded between runs, because the install moved";

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

function said(): string {
	return `The host wrote:\n${host?.errors()}`;
}

it(
	"a hosted conversation reloads onto the install's new version after its next run",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const install = join(sealed.home, "install");
			version(install, "one");
			const two = version(install, "two");
			moveTo(install, "one");
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: {
					PI_HOST_PACKAGE_DIR: pi,
					PI_HOST_TEST_HARNESS: join(install, "current"),
				},
			});
			const folder = join(sealed.home, "work");
			mkdirSync(folder, { recursive: true });
			const a = await host.open(folder, { model: SCRIPTED });

			moveTo(install, "two");
			const word = `steered-${randomUUID()}`;
			await steerInbox(sealed, sessionAddress(a.sessionId), word);
			await untilAnswered("the steer's run ends with a reload", async () =>
				textOf(a.file).includes(FOLLOWED),
			);

			const text = textOf(a.file);
			expect(text, "the steer ran first").toContain(word);
			expect(
				text.slice(text.indexOf(FOLLOWED)),
				"the reloaded runtime runs the new version",
			).toContain(relative(sealed.home, two));
		});
	},
	ROUND_TRIP_MS * 2,
);
