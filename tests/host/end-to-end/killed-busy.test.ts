/**
 * E11: a busy host killed outright brings every conversation back whole.
 * Three conversations share a host, one mid-turn in a tool that never
 * ends by itself, when the host is killed as an OOM kill or a crash
 * would. A new host resumes all three under their ids. Each log keeps
 * everything it held before the kill, unchanged, and every line of it
 * is a whole entry. The busy one's run is either taken up again or cut,
 * and a Stop ends it either way; then all three answer.
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
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	steerInbox,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { DAWDLE, DAWDLING, SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

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

/** The lines of a session file that don't parse as a whole entry. */
function brokenLines(file: string | undefined): string[] {
	return textOf(file)
		.split("\n")
		.filter((line) => line !== "")
		.filter((line) => {
			try {
				JSON.parse(line);
				return false;
			} catch {
				// Half an entry: what this check is looking for.
				return true;
			}
		});
}

it(
	"E11: a busy host killed outright resumes all three conversations whole",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const start = async () => {
				const host = await startHost({
					seal: sealed,
					engine: PI_ENGINE,
					env: { PI_HOST_PACKAGE_DIR: pi },
				});
				hosts.push(host);
				return host;
			};
			const first = await start();
			for (const folder of ["a", "b", "c"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const a = await first.open(join(sealed.home, "a"), { model: SCRIPTED });
			const b = await first.open(join(sealed.home, "b"), { model: SCRIPTED });
			const c = await first.open(join(sealed.home, "c"), {
				model: SCRIPTED,
				first: DAWDLE,
			});
			const all = [a, b, c];
			await untilAnswered(
				"the third conversation is busy in its tool",
				async () => textOf(c.file).includes(DAWDLING),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\nc: ${textOf(c.file)}`);
			});
			await answers(a, "the first answers while the third is busy");
			await answers(b, "the second answers while the third is busy");
			expect(turnEnded(c.file), "the third is still mid-turn").toBe(false);

			await first.kill();
			const before = all.map((one) => textOf(one.file));
			for (const [at, one] of all.entries())
				expect(
					brokenLines(one.file),
					`log ${at + 1} is whole after the kill`,
				).toEqual([]);

			const second = await start();
			await untilAnswered("the new host resumes all three", async () => {
				const held = (await second.list()).map((one) => one.sessionId);
				return all.every((one) => held.includes(one.sessionId));
			});
			for (const [at, one] of all.entries())
				expect(
					textOf(one.file).startsWith(before[at] ?? ""),
					`log ${at + 1} keeps what it held before the kill`,
				).toBe(true);

			// The cut-off gives the killed run again, back in its endless tool,
			// or the model answers it and ends the turn. Taken up again, it is
			// stopped as a person would; either way it must answer after.
			const dawdles = () => textOf(c.file).split(DAWDLING).length - 1;
			const killedIn = dawdles();
			await untilAnswered(
				"the third's killed run is taken up again or answered",
				async () => dawdles() > killedIn || turnEnded(c.file),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\nc: ${textOf(c.file)}`);
			});
			if (dawdles() > killedIn)
				await steerInbox(sealed, sessionAddress(c.sessionId), "", "stop");
			for (const [at, one] of all.entries())
				await answers(one, `conversation ${at + 1} answers after the kill`);
			for (const [at, one] of all.entries())
				expect(
					brokenLines(one.file),
					`log ${at + 1} is whole at the end`,
				).toEqual([]);
		});
	},
	// Two hosts' starts, three opens, a resume of three, a Stop and five round trips.
	ROUND_TRIP_MS * 6,
);
