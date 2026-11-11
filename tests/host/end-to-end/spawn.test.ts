/**
 * E6: a quest's session spawned into a host, as W12's done-means puts
 * it (extensions.md, W12). A plain pi in the seal orchestrates a parent
 * quest and spawns the child quest's session into the realm's attended
 * host with `quest spawn host:attended`. The child's first words arrive;
 * it shows on the mesh, in its presence and on a node of the sealed
 * realm, as one of the orchestration's; the orchestrator's `mesh_end`
 * closes it, through the host's control socket, and nothing else the
 * host holds; and `/quest-resume`, as the first words of a conversation
 * opened on the child quest, has the host adopt it again under the same
 * id, from its log.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, both for the
 * host and as the plain pi, and on mycelium for the node; skipped
 * saying why without either.
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { questAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import { nodeFor, type SealedNode, startNode } from "./support/node.ts";
import { type PlainPi, startPlainPi } from "./support/plain-pi.ts";
import { sealQuest } from "./support/quests.ts";
import { SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** The orchestrating quest, and the one under it whose session is hosted. */
const PARENT = "QEST-20261110-E6P000";
const CHILD = "QEST-20261110-E6C000";

let sealed: Seal;
let host: HostProcess | undefined;
let node: SealedNode | undefined;
let plain: PlainPi | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	node = undefined;
	plain = undefined;
});
afterEach(async () => {
	await plain?.stop();
	await host?.kill();
	await node?.stop();
	await sealed.dispose();
});

/** What the host, the node and the plain pi wrote, for a failure. */
function said(): string {
	return [
		`The host wrote:\n${host?.errors()}`,
		`The node wrote:\n${node?.errors()}`,
		`The plain pi wrote:\n${plain?.errors()}`,
	].join("\n");
}

/** What `/quest-resume` wrote into the conversation that asked, once it has. */
function resumeSaid(
	file: string | undefined,
): Record<string, unknown> | undefined {
	for (const line of textOf(file).split("\n").reverse()) {
		if (!line.includes('"quest-resume"')) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (
				isRecord(entry) &&
				entry.customType === "quest-resume" &&
				isRecord(entry.details)
			)
				return entry.details;
		} catch {
			// A line caught mid-write: the poll reads the file again.
		}
	}
	return undefined;
}

/** A session's presence, as far as E6 reads it, or nothing before one. */
function presenceOf(session: string):
	| {
			readonly hosted: boolean;
			readonly addresses: readonly string[];
			readonly orchestratedBy?: string;
			readonly orchestrates?: string;
	  }
	| undefined {
	const file = join(
		sealed.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"mesh-workflow",
		"presence",
		`${session}.json`,
	);
	try {
		const presence: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isRecord(presence)) return undefined;
		return {
			hosted: presence.hosted !== undefined,
			addresses: Array.isArray(presence.addresses)
				? presence.addresses.filter((one) => typeof one === "string")
				: [],
			...(typeof presence.orchestratedBy === "string"
				? { orchestratedBy: presence.orchestratedBy }
				: {}),
			...(typeof presence.orchestrates === "string"
				? { orchestrates: presence.orchestrates }
				: {}),
		};
	} catch {
		// Not published yet, or forgotten, or caught mid-write: the poll asks again.
		return undefined;
	}
}

it(
	"E6: a quest spawns a session into a host, which mesh_end closes alone and /quest-resume reopens",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			await nodeFor(sealed, skip);
			const mycelium = await startNode(sealed);
			node = mycelium;
			await sealQuest(sealed, {
				id: PARENT,
				title: "Orchestrate",
				orchestrator: true,
			});
			await sealQuest(sealed, {
				id: CHILD,
				title: "Be hosted",
				parent: PARENT,
			});
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			const stays = join(sealed.home, "stays");
			const orchestrates = join(sealed.home, "orchestrates");
			for (const folder of [stays, orchestrates])
				await mkdir(folder, { recursive: true });
			const other = await host.open(stays, { model: SCRIPTED });
			const opened = startPlainPi({
				seal: sealed,
				packageDir: pi,
				cwd: orchestrates,
			});
			plain = opened;
			const orchestrator = await opened.session();
			const lastSaid = (tool: string) => toolAnswer(orchestrator.file, tool);

			await opened.prompt(`load ${PARENT}`);
			await untilAnswered(
				"the plain pi orchestrates",
				async () =>
					presenceOf(orchestrator.sessionId)?.orchestrates ===
					questAddress(PARENT),
			);

			await opened.prompt(`spawn ${CHILD}`);
			const spawnedId = () =>
				/host opened session (\S+) in /.exec(lastSaid("quest") ?? "")?.[1];
			await untilAnswered(
				"the spawn opens the child's session in the host",
				async () => spawnedId() !== undefined,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${textOf(orchestrator.file)}`);
			});
			const child = spawnedId() ?? "";
			const held = async () =>
				(await host?.list())?.map((one) => one.sessionId) ?? [];
			expect(await held()).toContain(child);
			const childFile = (await host.list()).find(
				(one) => one.sessionId === child,
			)?.file;
			await untilAnswered("the child's first words arrive", async () =>
				textOf(childFile).includes(`Carry on with ${CHILD}`),
			);

			const address = questAddress(CHILD);
			await untilAnswered(
				"the child shows on the mesh as the orchestration's",
				async () => {
					const presence = presenceOf(child);
					return (
						presence?.hosted === true &&
						presence.addresses.includes(address) &&
						presence.orchestratedBy === questAddress(PARENT)
					);
				},
			);
			await untilAnswered("the node sees the child", async () =>
				(await mycelium.sessions()).some((one) => one.address === address),
			);

			await opened.prompt(`end ${address}`);
			await untilAnswered(
				"mesh_end closes the child alone",
				async () => {
					const now = await held();
					return !now.includes(child) && now.includes(other.sessionId);
				},
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${textOf(orchestrator.file)}`);
			});
			// The host's list can drop the child before pi writes the tool's
			// answer to the orchestrator's log, so wait for the answer too.
			await untilAnswered(
				"mesh_end's answer reaches the orchestrator's log",
				async () => lastSaid("mesh_end") !== undefined,
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${textOf(orchestrator.file)}`);
			});
			expect(lastSaid("mesh_end")).toContain(
				"Asked E6C000's host to close only that conversation",
			);

			const asking = await host.open(stays, {
				model: SCRIPTED,
				quest: CHILD,
				first: `/quest-resume ${child}`,
			});
			await untilAnswered(
				"/quest-resume has the host adopt the child under its id",
				async () => resumeSaid(asking.file) !== undefined,
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\n${textOf(asking.file)}`);
			});
			expect(resumeSaid(asking.file)).toEqual(
				expect.objectContaining({
					sessionId: child,
					host: `${sealed.realm}-attended`,
					adopted: true,
				}),
			);
			expect(await held()).toEqual(
				expect.arrayContaining([child, other.sessionId, asking.sessionId]),
			);
		});
	},
	// The host's and node's starts, two opens, a plain pi, a spawn, an end and a resume.
	ROUND_TRIP_MS * 4,
);
