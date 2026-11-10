/**
 * E9: the wave's cutover and its rollback, as wave 3's scripts run them
 * (scripts/host-cutover.ts and scripts/host-release.ts). Ten plain pis
 * each hold a conversation of their own: five a person prompted, five
 * that only a peer's message woke. The cutover moves every one into the
 * seal's hosts, the first five attended and the rest background, each
 * keeping its session and address, and asks the shell to keep each
 * window's place; a stand-in `qs` on PATH says it kept the five with a
 * window and that the rest had none, which the cutover lists. Every
 * conversation then answers in its host. The release hands all ten
 * back: the hosts drop them, restore.json offers each as released, and
 * each, opened in plain pi from the same file, answers again under the
 * same address; the first works on a quest, whose journal the release
 * tells what only the host held.
 * The set takes less than 45 minutes, as wave 3's done means asks.
 *
 * Each plain pi runs in a terminal of its own, as Joel's do, since only
 * there does pi end the moment a session moving out tells it to.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostKey } from "../../../host/service/address.ts";
import { restoreFilePath } from "../../../lib/internal/quest/restore-file.ts";
import { sessionRealm } from "../../../lib/internal/realm.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { questAddress, sessionAddress } from "../../../lib/mesh/address.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	steerInbox,
	textOf,
	untilAnswered,
} from "./support/hosted-case.ts";
import { harnessUnder, sealQuest } from "./support/quests.ts";
import { type Seal, seal } from "./support/seal.ts";
import { startTerminalPi, type TerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const ROOT = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

/** How many conversations wave 3's drill moves, and how many a person drives. */
const SESSIONS = 10;
const DRIVEN = 5;

/** The quest the first conversation works on, whose journal the release writes. */
const QUEST = "QEST-20261110-E9CUTS";

/** Wave 3's bound on the whole set, there and back. */
const SET_MS = 45 * 60_000;

/** A stand-in for the shell's `qs`: kept where a window was marked, else none. */
const QS = `#!/bin/sh
echo "$@" >> "$QS_LOG"
if [ -e "$QS_WINDOWS/$5" ]; then echo kept; else echo "no window to keep"; fi
`;

let sealed: Seal;
let hosts: HostProcess[] = [];
let plains: TerminalPi[] = [];
beforeEach(async () => {
	sealed = await seal();
	hosts = [];
	plains = [];
});
afterEach(async () => {
	await Promise.all(plains.map((one) => one.stop()));
	await Promise.all(hosts.map((one) => one.kill()));
	await sealed.dispose();
});

/** What the hosts and the plain pis wrote, for a failure. */
function said(): string {
	return [
		...hosts.map((one) => `A host wrote:\n${one.errors()}`),
		...plains.map((one) => `A plain pi wrote:\n${one.errors()}`),
	].join("\n");
}

const presences = () =>
	createPresences(
		join(
			sealed.env.XDG_STATE_HOME ?? "",
			"pi",
			"agentic-harness.pi",
			"mesh-workflow",
			"presence",
		),
	);

/** Run one of wave 3's scripts in the seal, answering its exit and output. */
async function script(
	name: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
	try {
		const { stdout } = await run(
			process.execPath,
			["--no-warnings", join(ROOT, "scripts", name), ...args],
			{ cwd: ROOT, env, timeout: SET_MS },
		);
		return { code: 0, out: stdout };
	} catch (error: unknown) {
		// execFile fails on a non-zero exit, carrying what the script wrote.
		if (!isRecord(error)) throw error;
		return {
			code: typeof error.code === "number" ? error.code : 1,
			out: `${String(error.stdout ?? "")}${String(error.stderr ?? "")}`,
		};
	}
}

/** Talk to the conversation at `address` and wait until it answers. */
async function answers(file: string, address: string, what: string) {
	const word = `hello-${randomUUID()}`;
	const before = repliesIn(file);
	await steerInbox(sealed, address, word);
	await untilAnswered(
		what,
		async () => textOf(file).includes(word) && repliesIn(file) > before,
	).catch((error: unknown) => {
		throw new Error(`${String(error)}\n${textOf(file)}`);
	});
}

it(
	"E9: ten conversations cut over into their hosts and released back keep their addresses and answer",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const start = Date.now();
			for (const kind of ["attended", "background"] as const)
				hosts.push(
					await startHost({
						seal: sealed,
						engine: PI_ENGINE,
						kind,
						env: { PI_HOST_PACKAGE_DIR: pi },
					}),
				);
			const folders = Array.from({ length: SESSIONS }, (_, i) =>
				join(sealed.home, `p${i}`),
			);
			for (const folder of folders) await mkdir(folder, { recursive: true });
			// Trusted as Joel's own folders are, answered once, as pi's
			// "Trust parent folder" writes it, under the path pi resolves.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			await sealQuest(sealed, { id: QUEST, title: "Cut Over and Back" });
			plains = await Promise.all(
				folders.map((cwd) =>
					startTerminalPi({ seal: sealed, packageDir: pi, cwd }),
				),
			);
			// The first works on a quest, as most of Joel's sessions do, and
			// goes by its quest's address.
			await plains[0]?.prompt(`load ${QUEST}`);
			await untilAnswered(
				"the first conversation works on its quest",
				async () => presences().of(plains[0]?.sessionId ?? "")?.quest === QUEST,
			);
			const address = plains.map((one, i) =>
				i === 0 ? questAddress(QUEST) : sessionAddress(one.sessionId),
			);

			// A person prompts the first five, each pinging one of the rest,
			// whom only that peer's message wakes.
			await Promise.all(
				plains
					.slice(0, DRIVEN)
					.map((one, i) => one.prompt(`ping ${address[i + DRIVEN]}`)),
			);
			await untilAnswered(
				"every pinged conversation answers its pinger, and each has a log",
				async () =>
					plains
						.slice(0, DRIVEN)
						.every((one) => textOf(one.file()).includes("pong heard")) &&
					plains.every((one) => one.file() !== undefined),
				ROUND_TRIP_MS * 2,
			);
			const sessions = plains.map((one) => ({
				sessionId: one.sessionId,
				file: one.file() ?? "",
			}));
			const before = sessions.map(
				(one) => presences().of(one.sessionId)?.addresses ?? [],
			);
			expect(
				sessions.map((one) => presences().of(one.sessionId)?.driven),
				"each says whether a person drives it",
			).toEqual([
				...Array(DRIVEN).fill(true),
				...Array(SESSIONS - DRIVEN).fill(false),
			]);

			// The shell kept a window for the driven five alone.
			const bin = join(sealed.root, "bin");
			const windows = join(sealed.root, "windows");
			await mkdir(bin);
			await mkdir(windows);
			await writeFile(join(bin, "qs"), QS);
			await chmod(join(bin, "qs"), 0o755);
			for (const one of sessions.slice(0, DRIVEN))
				await writeFile(join(windows, one.sessionId), "");
			const env = {
				...sealed.env,
				PATH: `${bin}:${sealed.env.PATH ?? ""}`,
				QS_LOG: join(sealed.root, "qs.log"),
				QS_WINDOWS: windows,
			};

			const cutover = await script(
				"host-cutover.ts",
				["--deadline", "20"],
				env,
			);
			expect(cutover.code, cutover.out).toBe(0);
			expect(cutover.out).toContain(`${SESSIONS} moved.`);
			for (const one of address.slice(DRIVEN))
				expect(cutover.out).toContain(
					`window not kept: ${one}, no window to keep`,
				);
			expect(
				(await readFile(join(sealed.root, "qs.log"), "utf8"))
					.trim()
					.split("\n"),
				"keepPlace asked for every one",
			).toHaveLength(SESSIONS);

			const [attended, background] = hosts;
			expect(
				((await attended?.list()) ?? []).map((one) => one.sessionId).sort(),
			).toEqual(
				sessions
					.slice(0, DRIVEN)
					.map((one) => one.sessionId)
					.sort(),
			);
			expect(
				((await background?.list()) ?? []).map((one) => one.sessionId).sort(),
			).toEqual(
				sessions
					.slice(DRIVEN)
					.map((one) => one.sessionId)
					.sort(),
			);
			for (const [i, one] of sessions.entries()) {
				expect(
					presences().of(one.sessionId)?.addresses,
					`${address[i]} keeps its addresses in its host`,
				).toEqual(before[i]);
				await answers(
					one.file,
					address[i] ?? "",
					`${address[i]} answers hosted`,
				);
			}

			const release = await script(
				"host-release.ts",
				["--all", "--deadline", "20"],
				env,
			);
			expect(release.code, release.out).toBe(0);
			expect(release.out).toContain(`${SESSIONS} released`);
			expect(release.out).not.toContain("not journaled");
			expect(
				await readFile(
					join(
						harnessUnder(sealed, "XDG_DATA_HOME"),
						"quest-workflow",
						"quests",
						QUEST,
						"JOURNEY.md",
					),
					"utf8",
				),
				"the quest's journal says what only the host held",
			).toMatch(
				new RegExp(
					`${address[0]} was released from the ${hostKey(sealed.realm, "attended")} host back to plain pi[^]*Only the host held its screen`,
				),
			);
			for (const host of hosts) expect(await host.list()).toEqual([]);
			const restore = JSON.parse(
				await readFile(
					restoreFilePath(
						sealed.env.XDG_STATE_HOME ?? "",
						sessionRealm(sealed.env),
					),
					"utf8",
				),
			);
			const offered = new Map(
				restore.sessions.map((one: { id: string }) => [one.id, one]),
			);
			for (const [i, one] of sessions.entries())
				expect(
					offered.get(one.sessionId),
					`${address[i]} is offered back`,
				).toMatchObject({
					address: address[i],
					released: {
						from: hostKey(sealed.realm, i < DRIVEN ? "attended" : "background"),
					},
				});

			// Reopen Them All: each in plain pi, from the same file.
			await Promise.all(plains.map((one) => one.stop()));
			plains = await Promise.all(
				sessions.map((one, i) =>
					startTerminalPi({
						seal: sealed,
						packageDir: pi,
						file: one.file,
						cwd: folders[i] ?? "",
					}),
				),
			);
			for (const [i, one] of sessions.entries()) {
				await untilAnswered(
					`${address[i]} runs in plain pi again`,
					async () => {
						const now = presences().of(one.sessionId);
						return now?.owner?.pid === plains[i]?.pid && !now?.hosted;
					},
				);
				expect(presences().of(one.sessionId)?.addresses).toEqual(before[i]);
				await answers(
					one.file,
					address[i] ?? "",
					`${address[i]} answers in plain pi`,
				);
			}
			expect(Date.now() - start, "the set, there and back").toBeLessThan(
				SET_MS,
			);
		});
	},
	SET_MS,
);
