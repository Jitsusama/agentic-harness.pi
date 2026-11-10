/**
 * E5: the rollback drill. One conversation of a sealed host stores rows
 * under a handle, is closed there, and has its log opened in a plain
 * `pi --session`, as a person backing out of the host would. The plain
 * pi publishes the same session under the same address, as a pi of its
 * own rather than a hosted one; its model is handed the hosted turn's
 * tool calls and results; it plays ping-pong over the mesh with the
 * other conversation, still in the host; and the handle stored in the
 * host answers it.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, both for the
 * host and as the plain pi; skipped saying why without one.
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { sessionAddress } from "../../../lib/mesh/address.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import { type PlainPi, startPlainPi } from "./support/plain-pi.ts";
import { SCRIPTED, STORE } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** A handle as the store mints it, cited in spend's answer. */
const HANDLE = /result-[0-9a-f]{16}/;

let sealed: Seal;
let host: HostProcess | undefined;
let plain: PlainPi | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	plain = undefined;
});
afterEach(async () => {
	await plain?.stop();
	await host?.kill();
	await sealed.dispose();
});

/** What the host and the plain pi wrote, for a failure. */
function said(): string {
	return `The host wrote:\n${host?.errors()}\nThe plain pi wrote:\n${plain?.errors()}`;
}

/** What a session's presence says: its owner's pid, whether hosted, its addresses. */
function presenceOf(session: string): {
	readonly pid?: number;
	readonly hosted: boolean;
	readonly addresses: readonly string[];
} {
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
		if (!isRecord(presence)) return { hosted: false, addresses: [] };
		const owner = isRecord(presence.owner) ? presence.owner : {};
		return {
			...(typeof owner.pid === "number" ? { pid: owner.pid } : {}),
			hosted: presence.hosted !== undefined,
			addresses: Array.isArray(presence.addresses)
				? presence.addresses.filter((one) => typeof one === "string")
				: [],
		};
	} catch {
		// Not published yet, or forgotten, or caught mid-write: the poll asks again.
		return { hosted: false, addresses: [] };
	}
}

/** The tools whose results a transcript holds, in order. */
function toolsAnswered(messages: readonly unknown[]): string[] {
	return messages.flatMap((message) =>
		isRecord(message) &&
		message.role === "toolResult" &&
		typeof message.toolName === "string"
			? [message.toolName]
			: [],
	);
}

it(
	"E5: a conversation opened in plain pi keeps its address, context and handles",
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
				first: STORE,
			});
			const address = sessionAddress(a.sessionId);
			const cited = () => HANDLE.exec(toolAnswer(a.file, "spend") ?? "")?.[0];
			await untilAnswered(
				"the hosted conversation cites a handle",
				// Its turn ends saying sent, once spend has answered.
				async () =>
					Boolean(cited()) && textOf(a.file).includes('"text":"sent"'),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(a.file)}`);
			});
			const handle = cited() ?? "";
			expect(presenceOf(a.sessionId).hosted).toBe(true);

			await host.close(a.sessionId);
			const opened = startPlainPi({
				seal: sealed,
				packageDir: pi,
				file: a.file ?? "",
				cwd: join(sealed.home, "a"),
			});
			plain = opened;
			await untilAnswered(
				"the plain pi publishes the same session as its own",
				async () => {
					const now = presenceOf(a.sessionId);
					return now.pid === opened.pid && !now.hosted;
				},
			);
			expect(presenceOf(a.sessionId).addresses).toContain(address);
			expect(toolsAnswered(await opened.messages())).toEqual([
				"tool_search",
				"spend",
			]);

			await opened.prompt(`ping ${sessionAddress(b.sessionId)}`);
			await untilAnswered(
				"the plain pi hears pong",
				async () => textOf(a.file).includes("pong heard"),
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(
					`${String(error)}\na: ${textOf(a.file)}\nb: ${textOf(b.file)}`,
				);
			});
			expect(textOf(b.file)).toMatch(/Mesh message \[[0-9a-f]+\] \(question\)/);

			await opened.prompt(`query ${handle}`);
			await untilAnswered(
				"the host's handle answers the plain pi",
				async () => toolAnswer(a.file, "result_query") !== undefined,
				ROUND_TRIP_MS,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(a.file)}`);
			});
			expect(toolAnswer(a.file, "result_query")).toMatch(/^50 matches\./);
		});
	},
	// The host's start, two opens and a store, a plain pi's start, and two round trips.
	ROUND_TRIP_MS * 4,
);
