/**
 * E27: a release of a conversation whose next prompts are already
 * queued as its run ends, as away mode's send-back and a peer's question
 * queue them, loses none of them. The conversation runs a tool that ends
 * by itself; while it runs, two steers and a peer's mesh question queue
 * behind it, and `host-release.ts --all` starts. Whether the host answers
 * them before it lets go or plain pi answers them after, each is answered
 * exactly once, the log stays whole and keeps what it held, and the
 * conversation answers in plain pi from the same file.
 *
 * E28: a release of a conversation away mode keeps sending back to work
 * lets it go within the release's deadline, and the send-back carries:
 * in plain pi, from the same file, it carries on by itself. Each
 * send-back has it run a tool, so away mode never stops for want of
 * tool calls, and its next run follows each run's end at once.
 *
 * Runs on a pi built with the host's patches, found as support/host-pi.ts
 * says; without one it is skipped saying how to get one, since an
 * ordinary check can't build the host's runtime. `pnpm test:host` runs it
 * and fails instead.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	steerInbox,
	textOf,
	toolAnswer,
	untilAnswered,
} from "./support/hosted-case.ts";
import {
	GO_AWAY,
	SCRIPTED,
	WAIT_A_WHILE,
	WAITED,
	WAITING,
} from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import { startTerminalPi, type TerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const ROOT = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

/** How long the release may wait on the busy one, in minutes. */
const DEADLINE_MINUTES = 10;

/**
 * How long E28's release may wait, in minutes: a few of its runs' twenty
 * seconds, well short of the move calling itself off.
 */
const AWAY_DEADLINE_MINUTES = 3;

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
		`The host wrote:\n${host?.errors()}`,
		`The plain pi wrote:\n${plain?.errors()}`,
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

/** The messages a session file records, by role. */
function messagesIn(file: string | undefined): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];
	for (const line of textOf(file).split("\n")) {
		if (line === "") continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (isRecord(entry) && isRecord(entry.message))
				messages.push(entry.message);
		} catch {
			// Half an entry, which brokenLines reports; no message to count.
		}
	}
	return messages;
}

/** How many of the person's messages in `file` say `word`. */
function toldIn(file: string | undefined, word: string): number {
	return messagesIn(file).filter(
		(one) => one.role === "user" && JSON.stringify(one.content).includes(word),
	).length;
}

/** How many times the conversation in `file` answered a ping with pong. */
function pongsIn(file: string | undefined): number {
	return messagesIn(file).filter((one) => {
		if (one.role !== "assistant") return false;
		const said = JSON.stringify(one.content);
		return said.includes("mesh_send") && said.includes('"text":"pong"');
	}).length;
}

/** How many times the conversation in `file` has called bash. */
function bashCallsIn(file: string | undefined): number {
	return messagesIn(file).filter(
		(one) =>
			one.role === "assistant" &&
			JSON.stringify(one.content).includes('"name":"bash"'),
	).length;
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

/** Run host-release.ts in the seal, answering its exit and output. */
async function release(
	minutes = DEADLINE_MINUTES,
): Promise<{ code: number; out: string }> {
	try {
		const { stdout } = await run(
			process.execPath,
			[
				"--no-warnings",
				join(ROOT, "scripts", "host-release.ts"),
				"--all",
				"--deadline",
				String(minutes),
			],
			{ cwd: ROOT, env: sealed.env, timeout: minutes * 60_000 * 2 },
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

it(
	"E27: a release as queued prompts follow a run's end loses none of them",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			// Trusted as Joel's own folders are, for the plain pi after.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			const cwd = join(sealed.home, "a");
			await mkdir(cwd, { recursive: true });
			await mkdir(join(sealed.home, "b"), { recursive: true });
			// Opened first, so its question takes a steer, not an open, once
			// the busy one is in its tool.
			const peer = await host.open(join(sealed.home, "b"), {
				model: SCRIPTED,
			});
			const busy = await host.open(cwd, {
				model: SCRIPTED,
				first: WAIT_A_WHILE,
			});
			const file = busy.file;
			await untilAnswered("the busy conversation is in its tool", async () =>
				textOf(file).includes(WAITING),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(file)}`);
			});
			const address = signature(busy.sessionId);

			// Queued behind the run: two prompts, as a send-back queues them,
			// and a peer's question.
			const queued = [`next-${randomUUID()}`, `then-${randomUUID()}`];
			for (const word of queued) await steerInbox(sealed, address, word);
			await steerInbox(sealed, signature(peer.sessionId), `ping ${address}`);
			await untilAnswered("the peer has asked", async () =>
				messagesIn(peer.file).some(
					(one) =>
						one.role === "assistant" &&
						JSON.stringify(one.content).includes("mesh_send"),
				),
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\nb: ${textOf(peer.file)}`);
			});
			expect(
				toolAnswer(file, "bash")?.includes(WAITED) ?? false,
				"the release starts while the run is under way",
			).toBe(false);

			const held = textOf(file);
			const released = await release();
			expect(released.code, released.out).toBe(0);
			expect(released.out).toContain("2 released");
			expect(await host.list(), "the host ends empty").toEqual([]);
			expect(brokenLines(file), "the log is whole after the release").toEqual(
				[],
			);
			const before = textOf(file);
			expect(
				before.startsWith(held),
				"the release keeps every entry it held",
			).toBe(true);

			// Plain pi, from the same file, answers whatever the host left.
			plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file: file ?? "",
				cwd,
			});
			await untilAnswered("it runs in its one plain pi", async () => {
				const now = presences().of(busy.sessionId);
				return now?.owner?.pid === plain?.pid && !now?.hosted;
			});
			await untilAnswered(
				"every prompt queued behind the run is answered",
				async () =>
					queued.every((word) => toldIn(file, word) > 0) && pongsIn(file) > 0,
				ROUND_TRIP_MS * 2,
			).catch((error: unknown) => {
				throw new Error(
					`${String(error)}\nbefore the release:\n${held}\nafter it:\n${before}\nnow:\n${textOf(file)}`,
				);
			});
			expect(
				textOf(file).startsWith(before),
				"plain pi keeps what the host left",
			).toBe(true);
			for (const word of queued)
				expect(toldIn(file, word), `${word} is told once`).toBe(1);
			expect(pongsIn(file), "the peer's question is answered once").toBe(1);

			const word = `hello-${randomUUID()}`;
			const replies = repliesIn(file);
			await steerInbox(sealed, address, word);
			await untilAnswered(
				"it answers in plain pi",
				async () => toldIn(file, word) === 1 && repliesIn(file) > replies,
			);
			expect(brokenLines(file), "the log is whole at the end").toEqual([]);
			expect(await host.list(), "the host took none back").toEqual([]);
		});
	},
	// A host, two opens, a twenty-second tool, a release, a plain pi and four round trips.
	ROUND_TRIP_MS * 8,
);

it(
	"E28: a release of a conversation away mode keeps sending back lets it go, and it carries on in plain pi",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			// Trusted as Joel's own folders are, for the plain pi after.
			await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
			await writeFile(
				join(sealed.home, ".pi", "agent", "trust.json"),
				JSON.stringify({ [await realpath(sealed.home)]: true }),
			);
			const cwd = join(sealed.home, "a");
			await mkdir(cwd, { recursive: true });
			// A hosted conversation keeps its own goal, not the machine's, so
			// it is told to go away itself, as a person would tell it.
			const away = await host.open(cwd, { model: SCRIPTED, first: GO_AWAY });
			const file = away.file;
			await untilAnswered(
				"away mode has sent it back to work",
				async () => bashCallsIn(file) >= 2,
				ROUND_TRIP_MS * 2,
			).catch((error: unknown) => {
				throw new Error(`${String(error)}\na: ${textOf(file)}`);
			});

			const held = textOf(file);
			const released = await release(AWAY_DEADLINE_MINUTES);
			expect(released.code, released.out).toBe(0);
			expect(released.out).toContain("1 released");
			expect(await host.list(), "the host ends empty").toEqual([]);
			expect(brokenLines(file), "the log is whole after the release").toEqual(
				[],
			);
			const before = textOf(file);
			expect(
				before.startsWith(held),
				"the release keeps every entry it held",
			).toBe(true);

			plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file: file ?? "",
				cwd,
			});
			await untilAnswered("it runs in its one plain pi", async () => {
				const now = presences().of(away.sessionId);
				return now?.owner?.pid === plain?.pid && !now?.hosted;
			});
			const calls = bashCallsIn(file);
			await untilAnswered(
				"it carries on by itself in plain pi",
				async () => bashCallsIn(file) > calls,
				ROUND_TRIP_MS * 2,
			).catch((error: unknown) => {
				throw new Error(
					`${String(error)}\nafter the release:\n${before}\nnow:\n${textOf(file)}`,
				);
			});
			expect(
				textOf(file).startsWith(before),
				"plain pi keeps what the host left",
			).toBe(true);
			expect(brokenLines(file), "the log is whole at the end").toEqual([]);
		});
	},
	// A host, an open, two of its runs, a release that may wait out its deadline, a plain pi and its run.
	ROUND_TRIP_MS * 10,
);
