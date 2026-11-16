/**
 * A hosted conversation that reloads onto its install's new version lets
 * the old version's code go. On 15 November the background host's heap
 * grew by hundreds of MB over evenings of install moves, and an old copy
 * kept alive by each reload would have explained it: every hosted
 * conversation reloads between runs when the install moves, and a copy is
 * about 15 MB. These cases showed it doesn't, and hold it there.
 *
 * The first reloads one conversation onto three new versions, reading the
 * host's heap through its inspector after a forced collection each time,
 * and holds the heap after the third within a bound of the first: well
 * under one copy's worth. Failing, it names what holds the first version's
 * scripts, from a heap snapshot of the sealed host. The second holds that
 * each old runtime's session_shutdown ends what mesh-workflow leaves
 * running process-wide: its teller in priority's awaited registry and its
 * lookAgain timer, either of which would keep its copy's whole module
 * graph.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
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
import {
	INSPECT_LOCALLY,
	type Inspector,
	inspect,
} from "./support/inspector.ts";
import { moveTo, version } from "./support/install.ts";
import { retainersOf } from "./support/retainers.ts";
import { SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** Where lib/internal/priority/awaited.ts keeps who tells it who waits. */
const AWAITED_TELLERS = "agentic-harness.priority.awaited.tellers";

/** What the reloaded runtime says, as lifecycle.ts's landedText puts it. */
const FOLLOWED = "Reloaded between runs, because the install moved";

/** The install's versions, in the order the conversation moves onto them. */
const VERSIONS = ["one", "two", "three", "four"];

const MB = 1024 * 1024;

/**
 * How much the heap may grow over two more reloads once one has landed:
 * what a reload's own records add, well under the 20 MB a copy held.
 */
const GROWTH_BOUND = 8 * MB;

/** How long a reload's teardown is given to finish before the heap is read. */
const SETTLE_MS = 3_000;

let sealed: Seal;
let host: HostProcess | undefined;
let inspector: Inspector | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	inspector = undefined;
});
afterEach(async () => {
	inspector?.close();
	await host?.kill();
	await sealed.dispose();
});

function said(): string {
	return `The host wrote:\n${host?.errors()}`;
}

/** How many times a conversation's log says it reloaded for the install. */
function reloadsIn(file: string | undefined): number {
	return textOf(file).split(FOLLOWED).length - 1;
}

/** One conversation opened on a host whose install is on version one. */
async function openedOnOne(pi: string) {
	const install = join(sealed.home, "install");
	for (const name of VERSIONS) version(install, name);
	moveTo(install, "one");
	host = await startHost({
		seal: sealed,
		engine: PI_ENGINE,
		env: {
			PI_HOST_PACKAGE_DIR: pi,
			PI_HOST_TEST_HARNESS: join(install, "current"),
		},
		nodeArgs: [INSPECT_LOCALLY],
	});
	const started = host;
	const inspecting = await inspect(() => started.errors());
	inspector = inspecting;
	const folder = join(sealed.home, "work");
	mkdirSync(folder, { recursive: true });
	const conversation = await host.open(folder, { model: SCRIPTED });
	return { install, conversation, inspecting };
}

/**
 * Move the install onto `name` and steer the conversation into a run, so
 * it reloads between runs as a live one does; then give the old runtime's
 * teardown, which runs on after the new one says it landed, time to end.
 */
async function reloadOnto(
	install: string,
	conversation: { sessionId: string; file?: string },
	name: string,
	before: number,
): Promise<void> {
	moveTo(install, name);
	await steerInbox(
		sealed,
		sessionAddress(conversation.sessionId),
		`steered-${randomUUID()}`,
	);
	await untilAnswered(
		`the reload onto ${name}`,
		async () => reloadsIn(conversation.file) > before,
	);
	await pause(SETTLE_MS);
}

/** What each loaded copy of mesh-workflow leaves running in the host. */
async function meshLeft(inspecting: Inspector): Promise<string> {
	const tellers = await inspecting.evaluate(
		`globalThis[Symbol.for("${AWAITED_TELLERS}")]?.size ?? 0`,
	);
	const looks = await inspecting.timersCalling("lookAgain");
	return `${String(tellers)} awaited tellers, ${looks} lookAgain timers`;
}

it(
	"a hosted conversation reloaded onto three new versions lets the old ones go",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const { install, conversation, inspecting } = await openedOnOne(pi);
			const heaps: number[] = [];
			for (const [moved, name] of VERSIONS.slice(1).entries()) {
				await reloadOnto(install, conversation, name, moved);
				heaps.push(await inspecting.heapAfterCollect());
			}

			const read = heaps.map((bytes) => `${(bytes / MB).toFixed(1)} MB`);
			const grew = (heaps.at(-1) ?? 0) - (heaps[0] ?? 0);
			const held =
				grew < GROWTH_BOUND
					? []
					: retainersOf(await inspecting.snapshot(), "/versions/one/");
			expect(
				grew,
				`the heap after each reload read ${read.join(", ")}; ${held.join("\n")}`,
			).toBeLessThan(GROWTH_BOUND);
		});
	},
	ROUND_TRIP_MS * 4,
);

it(
	"a hosted conversation reloaded onto new versions leaves one copy of mesh-workflow running",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const { install, conversation, inspecting } = await openedOnOne(pi);
			const opened = await meshLeft(inspecting);
			const ONE = "1 awaited tellers, 1 lookAgain timers";
			expect(opened, "one conversation, one copy running").toBe(ONE);
			const left: string[] = [];
			for (const [moved, name] of VERSIONS.slice(1, 3).entries()) {
				await reloadOnto(install, conversation, name, moved);
				left.push(`onto ${name}: ${await meshLeft(inspecting)}`);
			}
			expect(
				left,
				"each old runtime's session_shutdown ended its copy's teller and timer",
			).toEqual([`onto two: ${ONE}`, `onto three: ${ONE}`]);
		});
	},
	ROUND_TRIP_MS * 3,
);
