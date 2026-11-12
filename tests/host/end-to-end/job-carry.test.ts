/**
 * E17: a plain pi whose background command is still running moves into
 * the realm's background host by /host, without waiting for the command,
 * and the command runs on. Its end is said in the host, in the same
 * conversation and under the same job id, and nothing it kept on disk is
 * left once it is said. Before this a move waited out every job, so a
 * session that always had one never moved (OSPHT4, 12 November).
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { CARRIED_END, CARRY, CARRYING } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import {
	SCRIPTED_PROVIDER,
	startTerminalPi,
	type TerminalPi,
} from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/**
 * How long the move may take once asked: its 5 s with no key pressed, a
 * look every 2 s, the pi's end, and the take-up's look every 2 s. Well
 * inside the carried command's 45 s, so a move that waits it out fails.
 */
const MOVE_MS = 30_000;

/** How long the carried command runs, as CARRYING times it, and room past it. */
const CARRIED_MS = 45_000 + ROUND_TRIP_MS;

let sealed: Seal;
let host: HostProcess | undefined;
let plain: TerminalPi | undefined;
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
	return [
		host ? `The host wrote:\n${host.errors()}` : "",
		plain ? `The plain pi wrote:\n${plain.errors()}` : "",
	].join("\n");
}

/** The pid of the carried command's follow, by its command and the seal's HOME. */
function followIn(home: string): number | undefined {
	for (const name of readdirSync("/proc")) {
		const pid = Number(name);
		if (!Number.isInteger(pid)) continue;
		try {
			if (
				readFileSync(`/proc/${pid}/cmdline`, "utf8") !== "tail\0-f\0/dev/null\0"
			)
				continue;
			const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			if (env.includes(`HOME=${home}`)) return pid;
		} catch {
			// Gone, or another user's: not the follow asked about.
		}
	}
	return undefined;
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
	return existsSync(`/proc/${pid}`);
}

/** The words of the user messages and job results a log holds after `from`. */
function saidAfter(file: string, from: number): string {
	return textOf(file)
		.slice(from)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line): string => {
			const entry: unknown = JSON.parse(line);
			if (!isRecord(entry)) return "";
			const message = isRecord(entry.message) ? entry.message : entry;
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part: unknown) =>
					isRecord(part) && typeof part.text === "string" ? part.text : "",
				)
				.join("");
		})
		.join("\n");
}

/** What the shell keeps of its commands on disk, under the seal's state. */
function keptIn(seal: Seal): string[] {
	const folder = join(
		seal.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"shell-workflow",
		"kept",
	);
	return existsSync(folder)
		? readdirSync(folder, { recursive: true }).map(String)
		: [];
}

it(
	"E17: /host moves a plain pi with its background command running, and the command's end is said in the host",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			// A held pi takes no flag a restart would lose, so the scripted
			// model loads from the settings the host's engine wrote.
			const settings = join(sealed.home, ".pi", "agent", "settings.json");
			const written: unknown = JSON.parse(await readFile(settings, "utf8"));
			await writeFile(
				settings,
				JSON.stringify({
					...(isRecord(written) ? written : {}),
					extensions: [SCRIPTED_PROVIDER],
				}),
			);
			const cwd = join(sealed.home, "w");
			await mkdir(cwd, { recursive: true });
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			// The holder's files, as mycelium's hold keeps them.
			const hold = join(sealed.root, "hold");
			await mkdir(hold, { recursive: true });
			plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				cwd,
				env: {
					MYCELIUM_WAKE: join(hold, "e17.wake"),
					MYCELIUM_AGAIN: join(hold, "e17.again"),
				},
				bare: true,
			});
			await writeFile(
				join(hold, "e17.json"),
				JSON.stringify({ pid: plain.pid }),
			);
			await plain.prompt(CARRY);
			await untilAnswered(
				"the turn that started the command to end",
				async () =>
					textOf(plain?.file()).includes(CARRYING) && turnEnded(plain?.file()),
				ROUND_TRIP_MS,
			);
			const file = plain.file() ?? "";
			const follow = followIn(sealed.home);
			if (follow === undefined)
				throw new Error(`the carried command isn't running; ${said()}`);
			const held = await readFile(file, "utf8");

			plain.type("/host");
			await untilAnswered(
				"the plain pi ends, handing its window on",
				async () => plain?.ended() ?? true,
				MOVE_MS,
			);
			expect(
				alive(follow),
				"the pi moved while its command ran, and the command runs on",
			).toBe(true);
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

			await untilAnswered(
				"the command's end is said in the host, under its job id",
				async () => {
					const there = saidAfter(file, held.length);
					return there.includes(CARRIED_END) && there.includes("[j1]");
				},
				CARRIED_MS,
			);
			await untilAnswered(
				"nothing the shell kept of the command is left once its end is said",
				async () => keptIn(sealed).length === 0,
				ROUND_TRIP_MS,
			).catch((failed: unknown) => {
				throw new Error(
					`${String(failed)}; left: ${keptIn(sealed).join(", ")}`,
				);
			});
		});
	},
	ROUND_TRIP_MS * 3 + MOVE_MS * 2 + CARRIED_MS,
);
