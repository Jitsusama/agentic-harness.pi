/**
 * E2: a mycelium node of the sealed realm sees both conversations of one
 * host, as the person does through `mycelium sessions`, and a steer it
 * delivers reaches the conversation it names and no other. Once one
 * conversation is closed, the node no longer holds it and still holds
 * the other idle: a hosted conversation forgets its presence as it
 * closes, since its host lives on and would keep it reading idle
 * (keying.md 2.5's table: gone).
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, and on the
 * `mycelium` the sealed PATH has; without either it is skipped saying
 * why, and `pnpm test:host` fails instead.
 */

import { randomUUID } from "node:crypto";
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
import { nodeFor, type SealedNode, startNode } from "./support/node.ts";
import { SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

let sealed: Seal;
let host: HostProcess | undefined;
let node: SealedNode | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	node = undefined;
});
afterEach(async () => {
	await host?.kill();
	await node?.stop();
	await sealed.dispose();
});

/** What the host and the node wrote, for a failure. */
function said(): string {
	return `The host wrote:\n${host?.errors()}\nThe node wrote:\n${node?.errors()}`;
}

it(
	"E2: a steer reaches the conversation it names, and the node sees each",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			await nodeFor(sealed, skip);
			const mycelium = await startNode(sealed);
			node = mycelium;
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			for (const folder of ["a", "b"])
				await mkdir(join(sealed.home, folder), { recursive: true });
			const a = await host.open(join(sealed.home, "a"), { model: SCRIPTED });
			const b = await host.open(join(sealed.home, "b"), { model: SCRIPTED });
			const at = {
				a: sessionAddress(a.sessionId),
				b: sessionAddress(b.sessionId),
			};
			const states = async () => {
				const seen = await mycelium.sessions();
				const of = (address: string) =>
					seen.find((one) => one.address === address)?.state;
				return { a: of(at.a), b: of(at.b), seen };
			};

			await untilAnswered("the node sees both conversations idle", async () => {
				const now = await states();
				return now.a === "idle" && now.b === "idle";
			}).catch(async (error: unknown) => {
				throw new Error(`${String(error)}: ${JSON.stringify(await states())}`);
			});

			const word = `steered-${randomUUID()}`;
			await mycelium.steer(at.b, word);
			await untilAnswered(
				"the steer reaches the second conversation",
				async () => textOf(b.file).includes(word),
			);
			expect(textOf(b.file)).toContain("[Steered by");
			expect(textOf(a.file)).not.toContain(word);

			await host.close(b.sessionId);
			await untilAnswered(
				"the node lets the closed conversation go",
				async () => {
					const now = await states();
					return now.a === "idle" && now.b === undefined;
				},
			).catch(async (error: unknown) => {
				throw new Error(`${String(error)}: ${JSON.stringify(await states())}`);
			});
		});
	},
	ROUND_TRIP_MS * 2,
);
