/**
 * E12: item 11's rollback drill, `host-release.ts --all`, from hosts
 * holding several conversations, one of them mid-run. Both of the
 * seal's hosts hold two, the first on a quest and one in a tool that
 * never ends by itself. The release hands back each one nothing holds
 * and waits on the busy one until a Stop ends its run, as a person
 * would; then both hosts are empty and restore.json offers all four as
 * released. Each log keeps everything it held, unchanged, and holds
 * only whole entries, and the quest's journal says what only the host
 * held. Opened again in plain pi from the same file, as Reopen Them All
 * opens it, each runs in exactly that one pi under the addresses it had,
 * and answers.
 *
 * Where each window goes is the launcher's (Places.js and niri's
 * open-focused rule), so this opens none: each plain pi runs in a
 * terminal of its own under script(1), as E9's do.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type HostKind, hostKey } from "../../../host/service/address.ts";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import { restoreFilePath } from "../../../lib/internal/quest/restore-file.ts";
import { sessionRealm } from "../../../lib/internal/realm.ts";
import { isRecord } from "../../../lib/internal/record.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
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
import { harnessUnder, sealQuest } from "./support/quests.ts";
import { DAWDLE, DAWDLING, SCRIPTED } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import { startTerminalPi, type TerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const ROOT = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

/** The quest the first conversation works on, whose journal the release writes. */
const QUEST = "QEST-20261111-E12REL";

/** How long the release may wait on the busy one, in minutes. */
const DEADLINE_MINUTES = 10;

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

/** The address a conversation signs with, its first. */
function signature(sessionId: string): string {
	return presences().of(sessionId)?.addresses?.[0] ?? "";
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

/** The lines of a session file that don't parse as a whole entry. */
function brokenLines(file: string): string[] {
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

/** Run host-release.ts in the seal, answering its exit and output. */
async function release(): Promise<{ code: number; out: string }> {
	try {
		const { stdout } = await run(
			process.execPath,
			[
				"--no-warnings",
				join(ROOT, "scripts", "host-release.ts"),
				"--all",
				"--deadline",
				String(DEADLINE_MINUTES),
			],
			{ cwd: ROOT, env: sealed.env, timeout: DEADLINE_MINUTES * 60_000 * 2 },
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

/** One hosted conversation, where it runs and what it held before. */
interface Held {
	readonly one: SessionIdentity;
	readonly kind: HostKind;
	readonly cwd: string;
}

it(
	"E12: a release of all from busy hosts hands each back whole, to one plain pi",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const [attended, background] = await Promise.all(
				(["attended", "background"] as const).map((kind) =>
					startHost({
						seal: sealed,
						engine: PI_ENGINE,
						kind,
						env: { PI_HOST_PACKAGE_DIR: pi },
					}),
				),
			);
			if (attended === undefined || background === undefined)
				throw new Error("both hosts start");
			hosts.push(attended, background);
			// Trusted as Joel's own folders are, for the plain pis after.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			await sealQuest(sealed, { id: QUEST, title: "Release Them All" });
			const opened: Held[] = [];
			const open = async (
				kind: HostKind,
				name: string,
				extra: { first?: string; quest?: string } = {},
			) => {
				const cwd = join(sealed.home, name);
				await mkdir(cwd, { recursive: true });
				const host = kind === "attended" ? attended : background;
				const one = await host.open(cwd, { model: SCRIPTED, ...extra });
				opened.push({ one, kind, cwd });
				return one;
			};
			const onQuest = await open("attended", "a", { quest: QUEST });
			await open("attended", "b");
			await open("background", "c");
			const busy = await open("background", "d", { first: DAWDLE });
			await untilAnswered(
				"the busy conversation is in its tool",
				async () => textOf(busy.file).includes(DAWDLING),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\nd: ${textOf(busy.file)}`);
			});
			await untilAnswered(
				"the first works on its quest",
				async () => presences().of(onQuest.sessionId)?.quest === QUEST,
			);
			for (const { one } of opened.filter(({ one }) => one !== busy))
				await answers(
					one.file ?? "",
					signature(one.sessionId),
					`${signature(one.sessionId)} answers hosted`,
				);
			expect(turnEnded(busy.file), "the busy one is mid-run").toBe(false);
			const addresses = opened.map(
				({ one }) => presences().of(one.sessionId)?.addresses ?? [],
			);

			const releasing = release();
			// Those nothing holds go at once; the busy one waits for its run.
			await untilAnswered(
				"every conversation but the busy one is let go",
				async () => {
					const held = [
						...(await attended.list()),
						...(await background.list()),
					].map((one) => one.sessionId);
					return held.length === 1 && held[0] === busy.sessionId;
				},
				ROUND_TRIP_MS * 2,
			);
			await steerInbox(sealed, signature(busy.sessionId), "", "stop");
			const released = await releasing;
			expect(released.code, released.out).toBe(0);
			expect(released.out).toContain(`${opened.length} released`);
			expect(await attended.list(), "the attended host ends empty").toEqual(
				[],
			);
			expect(
				await background.list(),
				"the background host ends empty",
			).toEqual([]);

			const before = opened.map(({ one }) => textOf(one.file));
			for (const { one } of opened)
				expect(
					brokenLines(one.file ?? ""),
					`${one.sessionId}'s log is whole after the release`,
				).toEqual([]);
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
			for (const [at, { one, kind }] of opened.entries())
				expect(
					offered.get(one.sessionId),
					`${one.sessionId} is offered back`,
				).toMatchObject({
					address: addresses[at]?.[0],
					released: { from: hostKey(sealed.realm, kind) },
				});
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
			).toContain(
				`was released from the ${hostKey(sealed.realm, "attended")} host back to plain pi`,
			);

			// Reopen Them All: each in plain pi, from the same file.
			plains = await Promise.all(
				opened.map(({ one, cwd }) =>
					startTerminalPi({
						seal: sealed,
						packageDir: pi,
						file: one.file ?? "",
						cwd,
					}),
				),
			);
			for (const [at, { one }] of opened.entries()) {
				await untilAnswered(
					`${one.sessionId} runs in its one plain pi`,
					async () => {
						const now = presences().of(one.sessionId);
						return now?.owner?.pid === plains[at]?.pid && !now?.hosted;
					},
				);
				expect(
					textOf(one.file).startsWith(before[at] ?? ""),
					`${one.sessionId}'s log keeps what it held`,
				).toBe(true);
				expect(
					presences().of(one.sessionId)?.addresses,
					`${one.sessionId} keeps its addresses`,
				).toEqual(addresses[at]);
				await answers(
					one.file ?? "",
					addresses[at]?.[0] ?? "",
					`${one.sessionId} answers in plain pi`,
				);
				expect(
					brokenLines(one.file ?? ""),
					`${one.sessionId}'s log is whole at the end`,
				).toEqual([]);
			}
			expect(
				[...(await attended.list()), ...(await background.list())],
				"neither host took any back",
			).toEqual([]);
		});
	},
	// Two hosts, four opens, a release waiting on a Stop, four plain pis, seven round trips.
	ROUND_TRIP_MS * 10,
);
