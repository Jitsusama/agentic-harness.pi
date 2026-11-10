/**
 * E4: a host killed and started again keeps each conversation's address
 * and its stored results. One conversation stores a query's rows under a
 * handle; the host is killed outright, as a crash or an OOM kill would;
 * once a new host has resumed both, a steer to the address it had before
 * reaches it, and its query of the handle cited before the kill answers.
 * Neither is offered to reopen in a window, while the host is dead or
 * after it is back: the launcher's Sessions to Reopen, as the next
 * boot's restore file would give it (support/reopen.ts), leaves both
 * out, each marked hosted, and `quest reopen-sessions` names neither.
 *
 * The steer is written into the inbox as the launcher writes one, so
 * this needs no mycelium node. Runs on the host's pi, as
 * support/host-pi.ts finds it, skipped saying why without one.
 */

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
import { launcherOffers, nextBootRestore } from "./support/reopen.ts";
import { REOPEN, SCRIPTED, STORE } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** A handle as the store mints it, cited in spend's answer. */
const HANDLE = /result-[0-9a-f]{16}/;

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

it(
	"E4: a killed host's conversations keep their addresses and handles",
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
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const b = await first.open(join(sealed.home, "b"), { model: SCRIPTED });
			const a = await first.open(join(sealed.home, "a"), {
				model: SCRIPTED,
				first: STORE,
			});
			const cited = () => HANDLE.exec(toolAnswer(a.file, "spend") ?? "")?.[0];
			await untilAnswered("the first conversation cites a handle", async () =>
				Boolean(cited()),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(a.file)}`);
			});
			const handle = cited() ?? "";

			const ids = [a.sessionId, b.sessionId].sort();
			const noneOffered = (when: string) => {
				const restore = nextBootRestore(sealed);
				const ours = restore.sessions.filter((one) => ids.includes(one.id));
				expect(
					ours.map((one) => [one.id, one.hosted]).sort(),
					`${when}, the next boot's restore file marks both hosted: ${JSON.stringify(restore)}`,
				).toEqual(ids.map((id) => [id, true]));
				expect(
					launcherOffers(restore).map((one) => one.id),
					`${when}, the launcher offers neither to reopen`,
				).toEqual([]);
			};

			await first.kill();
			noneOffered("With the host dead");
			const second = await start();
			await untilAnswered("the new host resumes both", async () => {
				const held = (await second.list()).map((one) => one.sessionId);
				return held.includes(a.sessionId) && held.includes(b.sessionId);
			});
			noneOffered("With the host back");
			await steerInbox(sealed, sessionAddress(b.sessionId), REOPEN);
			await untilAnswered(
				"reopen-sessions answers",
				async () => toolAnswer(b.file, "quest") !== undefined,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\nb: ${textOf(b.file)}`);
			});
			const reopen = toolAnswer(b.file, "quest") ?? "";
			for (const id of ids)
				expect(reopen, "reopen-sessions names no hosted session").not.toContain(
					id,
				);

			await steerInbox(sealed, sessionAddress(a.sessionId), `query ${handle}`);
			await untilAnswered(
				"the handle answers after the restart",
				async () => toolAnswer(a.file, "result_query") !== undefined,
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(a.file)}`);
			});
			expect(toolAnswer(a.file, "result_query")).toMatch(/^50 matches\./);
		});
	},
	// Two hosts' starts, a resume of both conversations, and three round trips.
	ROUND_TRIP_MS * 5,
);
