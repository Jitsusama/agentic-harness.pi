/**
 * E21: a plain pi whose background fleet is still running moves into the
 * realm's background host by /host, and the fleet runs on. Its two
 * subagents end, one during the move and one well after it, and the
 * fleet's summary is said in the host, in the same conversation and
 * under the same job id and run id. Before this a move waited out a
 * fleet, or would have killed its subagents had it not.
 *
 * E22 is the move that fails: the host refuses the log, the move is
 * taken back as the window's join takes it back, and plain pi, opened
 * on the same log as the join opens it, says the summary the same way.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { takeBackMove } from "../../../lib/internal/session/move.ts";
import { saidAfter, startHeldPi } from "./support/held-pi.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { CARRIED_FLEET, SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import { startTerminalPi, type TerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const PROVIDER = resolve(import.meta.dirname, "support/scripted-provider.ts");

/** How long the move may take once asked, as E17 times it. */
const MOVE_MS = 30_000;

/**
 * How long the fleet runs: its longer subagent's 50 s, beside each
 * subagent's pi starting, and room past it.
 */
const FLEET_MS = 50_000 + ROUND_TRIP_MS;

/**
 * How long the window's join waits before it takes a move nobody
 * adopted back (host/service/join.ts JOIN_GRACE_MS), so the host has
 * refused the log by then.
 */
const JOIN_GRACE_MS = 10_000;

let sealed: Seal;
let host: HostProcess | undefined;
let plain: TerminalPi | undefined;
let reopened: TerminalPi | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	plain = undefined;
	reopened = undefined;
});
afterEach(async () => {
	await reopened?.stop();
	await plain?.stop();
	await host?.kill();
	await sealed.dispose();
});

/** What the host and the plain pis wrote, for a failure. */
function said(): string {
	return [
		host ? `The host wrote:\n${host.errors()}` : "",
		plain ? `The plain pi wrote:\n${plain.errors()}` : "",
		reopened ? `The reopened pi wrote:\n${reopened.errors()}` : "",
	].join("\n");
}

/** Where moves leave their notes, under the seal's state. */
function moves(): string {
	return join(
		sealed.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"moves",
	);
}

/**
 * Start a held plain pi, have it dispatch the fleet in the background,
 * and answer its log and what the log held once that turn ended.
 */
async function fleetInPlainPi(
	pi: string,
	name: string,
): Promise<{ file: string; held: string }> {
	plain = await startHeldPi(sealed, pi, name);
	const work = join(sealed.home, "w");
	await plain.prompt(`fleet-carry ${work} ${PROVIDER}`);
	await untilAnswered(
		"the turn that dispatched the fleet ends, naming its job",
		async () =>
			textOf(plain?.file()).includes(CARRIED_FLEET) && turnEnded(plain?.file()),
		ROUND_TRIP_MS,
	).catch((failed: unknown) => {
		throw new Error(`${String(failed)}\n${textOf(plain?.file())}\n${said()}`);
	});
	const file = plain.file() ?? "";
	return { file, held: await readFile(file, "utf8") };
}

/** Wait until the fleet's summary is said in `file` after `from`, under j1. */
async function summarySaid(file: string, from: number): Promise<string> {
	let there = "";
	await untilAnswered(
		"the fleet's summary is said under its job id and run id",
		async () => {
			there = saidAfter(file, from);
			return (
				there.includes(`Fleet ${CARRIED_FLEET}:`) && there.includes("[j1]")
			);
		},
		FLEET_MS,
	).catch((failed: unknown) => {
		throw new Error(`${String(failed)}\nsaid since:\n${there}\n${said()}`);
	});
	return there;
}

it(
	"E21: /host moves a plain pi with its background fleet running, and the fleet's summary is said in the host",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			const { file, held } = await fleetInPlainPi(pi, "e21");

			plain?.type("/host");
			await untilAnswered(
				"the plain pi ends, handing its window on",
				async () => plain?.ended() ?? true,
				MOVE_MS,
			).catch((failed: unknown) => {
				throw new Error(`${String(failed)}\n${said()}`);
			});
			await untilAnswered(
				"the background host lists the conversation",
				async () =>
					((await host?.list()) ?? []).some(
						(one) => one.sessionId === plain?.sessionId,
					),
				MOVE_MS,
			);
			expect(
				textOf(file).startsWith(held),
				"its log keeps what the pi held",
			).toBe(true);

			const there = await summarySaid(file, held.length);
			expect(there, "both subagents ran on through the move").toContain(
				"2/2 complete",
			);
			expect(there).toContain("carried here by a move");
		});
	},
	ROUND_TRIP_MS * 3 + MOVE_MS * 2 + FLEET_MS,
);

it(
	"E22: a move the host refuses leaves the fleet to plain pi, which says its summary",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
				admitsOne: true,
			});
			// The one conversation it admits, so it refuses the next.
			const admitted = join(sealed.home, "admitted");
			await mkdir(admitted, { recursive: true });
			await host.open(admitted, { model: SCRIPTED });
			const work = join(sealed.home, "w");
			const { file, held } = await fleetInPlainPi(pi, "e22");
			const session = plain?.sessionId ?? "";

			plain?.type("/host");
			await untilAnswered(
				"the plain pi ends, handing its window on",
				async () => plain?.ended() ?? true,
				MOVE_MS,
			).catch((failed: unknown) => {
				throw new Error(`${String(failed)}\n${said()}`);
			});
			// A fixed wait, because it is the join's: its grace, in which the
			// host refuses the log, before it takes the move back.
			await new Promise((done) => setTimeout(done, JOIN_GRACE_MS));
			await untilAnswered(
				"the move is taken back once the host has refused it",
				async () => takeBackMove(session, process.pid, moves()) === "taken",
				MOVE_MS,
			).catch((failed: unknown) => {
				throw new Error(`${String(failed)}\n${said()}`);
			});
			expect(
				((await host.list()) ?? []).some((one) => one.sessionId === session),
				"the host refused the log",
			).toBe(false);

			reopened = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file,
				cwd: work,
			});
			const there = await summarySaid(file, held.length);
			expect(there, "both subagents ran on through the failed move").toContain(
				"2/2 complete",
			);
			expect(there).toContain("carried here by a move");
		});
	},
	ROUND_TRIP_MS * 4 + MOVE_MS * 3 + JOIN_GRACE_MS + FLEET_MS,
);
