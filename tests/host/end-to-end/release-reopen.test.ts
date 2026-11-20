/**
 * E29 and E30: two of the 15 November drill's gaps, from end to end.
 *
 * E29, a released tree: a hosted conversation whose folder went while
 * its host held it, as an agent's own worktree goes when it gives it
 * back, beside one whose folder stands. The release hands the launcher
 * the one it can open, as the conversation leaves, and only offers the
 * other, printing how to open it in place, since pi opened by id from
 * elsewhere asks whether to fork and nobody sees the question in a window
 * opened for nobody. The launcher here is a stand-in `qs` that writes
 * down what it was asked and says it took it; the seal has no shell.
 *
 * E30, a reload with a move pending: a conversation told to move while
 * its run goes on, whose install moves under that run, so the run's end
 * both lets the move go and asks to reload it onto the new version, as
 * XUBK2E's did at 05:53. Which of the two goes first is the race's own:
 * XUBK2E's reload began a second before its move, while here the move
 * usually wins, since the follower asks git why before it reloads. The
 * note survives either way, so the case checks that, and is offered,
 * and opened from its file in plain pi it answers; move-notes.test.ts
 * pins the reload-first order, where a reload's start leaves the note.
 *
 * E31, an untrusted folder: a conversation the background host ran in a
 * folder nobody trusted, which it left untrusted with nobody there to
 * ask. Opened from its file in plain pi after the release, it starts and
 * answers rather than waiting at pi's trust prompt, as 2FC18ED8 and
 * QQ1UAK waited 11 minutes, and pi saves no decision for the folder.
 *
 * Runs on the host's pi, as support/host-pi.ts finds it, skipped saying
 * why without one.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hostKey } from "../../../host/service/address.ts";
import { sessionRealm } from "../../../lib/internal/machine/realm.ts";
import { restoreFilePath } from "../../../lib/internal/quest/reopening/restore-file.ts";
import { isRecord } from "../../../lib/internal/record.ts";
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
import { SCRIPTED, WAIT_A_WHILE } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import { startTerminalPi, type TerminalPi } from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");
const ROOT = resolve(import.meta.dirname, "../../..");
const run = promisify(execFile);

/** How long a release may wait on a busy one, in minutes. */
const DEADLINE_MINUTES = 5;

/** What a version of the install leaves out of the tree, at its top. */
const LEFT_OUT = new Set(["node_modules", ".git", "tests"]);

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

/** What the seal's moves folder holds, each file with its text, for a failure. */
function movesSaid(): string {
	const folder = join(
		sealed.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"moves",
	);
	try {
		const names = readdirSync(folder);
		if (names.length === 0) return "The moves folder is empty.";
		return names
			.map((name) => `${name}: ${readFileSync(join(folder, name), "utf8")}`)
			.join("\n");
	} catch (error) {
		return `No moves folder to read: ${String(error)}`;
	}
}

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

/** Trust the seal's home, as Joel's own folders are, for the plain pis after. */
function trustHome(): void {
	mkdirSync(join(sealed.home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(sealed.home, ".pi", "agent", "trust.json"),
		JSON.stringify({ [realpathSync(sealed.home)]: true }),
	);
}

/** The folders pi's trust store holds a decision for. */
function savedTrust(): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(
			readFileSync(join(sealed.home, ".pi", "agent", "trust.json"), "utf8"),
		);
		return isRecord(value) ? value : {};
	} catch {
		// No store yet: no decision saved.
		return {};
	}
}

/**
 * A stand-in for the launcher's `qs` on the release's PATH, writing
 * each reopen it is asked for to `asked`, one JSON a line, and saying
 * it took it, as the launcher does before it opens anything.
 */
function standInLauncher(): { path: string; asked: string } {
	const bin = join(sealed.home, "bin");
	const asked = join(sealed.home, "launcher-asked.jsonl");
	mkdirSync(bin, { recursive: true });
	const qs = join(bin, "qs");
	writeFileSync(
		qs,
		`#!/bin/sh\nprintf '%s\\n' "$5" >> '${asked}'\necho taken\n`,
	);
	chmodSync(qs, 0o755);
	return { path: `${bin}:${sealed.env.PATH ?? ""}`, asked };
}

/** Every session the stand-in launcher was asked to reopen. */
function askedToReopen(asked: string): { id: string; cwd: string }[] {
	let text = "";
	try {
		text = readFileSync(asked, "utf8");
	} catch {
		// Never asked: no file.
		return [];
	}
	return text
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line) => {
			const value: unknown = JSON.parse(line);
			return isRecord(value) && Array.isArray(value.sessions)
				? value.sessions.filter(isRecord).map((one) => ({
						id: String(one.id),
						cwd: String(one.cwd),
					}))
				: [];
		});
}

/** Run host-release.ts in the seal, answering its exit and output. */
async function release(
	names: readonly string[],
	options: { offer?: boolean; path?: string } = {},
): Promise<{ code: number; out: string }> {
	try {
		const { stdout } = await run(
			process.execPath,
			[
				"--no-warnings",
				join(ROOT, "scripts", "host-release.ts"),
				...names,
				...(options.offer ? ["--offer"] : []),
				"--deadline",
				String(DEADLINE_MINUTES),
			],
			{
				cwd: ROOT,
				env: {
					...sealed.env,
					...(options.path ? { PATH: options.path } : {}),
				},
				timeout: DEADLINE_MINUTES * 60_000 * 2,
			},
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

/** The sessions restore.json offers back, by id. */
function offered(): Map<string, unknown> {
	const restore: unknown = JSON.parse(
		readFileSync(
			restoreFilePath(
				sealed.env.XDG_STATE_HOME ?? "",
				sessionRealm(sealed.env),
			),
			"utf8",
		),
	);
	const sessions =
		isRecord(restore) && Array.isArray(restore.sessions)
			? restore.sessions.filter(isRecord)
			: [];
	return new Map(sessions.map((one) => [String(one.id), one]));
}

/**
 * A version of the install under `versions`: this tree's code, sharing
 * its installed dependencies, with a lockfile older than their install
 * record, so the follower takes it as installed (as follow-install's).
 */
function version(install: string, name: string): string {
	const folder = join(install, "versions", name);
	cpSync(ROOT, folder, {
		recursive: true,
		filter: (from) => !LEFT_OUT.has(relative(ROOT, from)),
	});
	symlinkSync(join(ROOT, "node_modules"), join(folder, "node_modules"));
	utimesSync(join(folder, "pnpm-lock.yaml"), 0, 0);
	return folder;
}

/** Move the install's link onto `name` in one rename, as pi-packages does. */
function moveTo(install: string, name: string): void {
	const link = join(install, "current");
	symlinkSync(join("versions", name), `${link}.new`);
	renameSync(`${link}.new`, link);
}

it(
	"E29: a release hands the launcher the one it can open and only offers one whose folder went",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			hosts.push(host);
			trustHome();
			// As pi names them, so the release's words and the launcher's agree.
			const home = realpathSync(sealed.home);
			const standing = join(home, "standing");
			const going = join(home, "going");
			mkdirSync(standing, { recursive: true });
			mkdirSync(going, { recursive: true });
			const kept = await host.open(standing, { model: SCRIPTED });
			const gone = await host.open(going, { model: SCRIPTED });
			for (const one of [kept, gone])
				await answers(
					one.file ?? "",
					signature(one.sessionId),
					`${signature(one.sessionId)} answers hosted`,
				);
			const address = signature(kept.sessionId);
			// Given back while its host holds it, as a worktree goes.
			rmSync(going, { recursive: true, force: true });

			const launcher = standInLauncher();
			const released = await release(["--all"], { path: launcher.path });
			expect(released.code, released.out).toBe(0);
			expect(released.out).toContain(
				"2 released: 1 reopened by the launcher, 0 carried on in their windows, 1 offered in Sessions to Reopen.",
			);
			expect(released.out, "how to open the one whose folder went").toContain(
				`${gone.sessionId}: its folder ${going} is gone, so it is only offered; open it with pi --session ${gone.file}`,
			);
			expect(
				askedToReopen(launcher.asked),
				"the launcher is asked for the one it can open, alone",
			).toEqual([{ id: kept.sessionId, cwd: standing }]);
			expect(await host.list(), "the host ends empty").toEqual([]);
			expect(
				offered().get(gone.sessionId),
				"the one whose folder went waits in Sessions to Reopen",
			).toMatchObject({
				released: { from: hostKey(sealed.realm, "background") },
			});

			// What the launcher opens: plain pi on the session, in its folder.
			const plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file: kept.file ?? "",
				cwd: standing,
			});
			plains.push(plain);
			await untilAnswered(
				`${kept.sessionId} runs in its one plain pi`,
				async () => {
					const now = presences().of(kept.sessionId);
					return now?.owner?.pid === plain.pid && !now?.hosted;
				},
			);
			await answers(
				kept.file ?? "",
				address,
				`${kept.sessionId} answers in plain pi`,
			);
		});
	},
	// One host, two opens, a release past the reopen's grace, one plain pi, four round trips.
	ROUND_TRIP_MS * 6,
);

it(
	"E30: a move whose run ends as its install moves still leaves its note",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const install = join(sealed.home, "install");
			version(install, "one");
			version(install, "two");
			moveTo(install, "one");
			const host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: {
					PI_HOST_PACKAGE_DIR: pi,
					PI_HOST_TEST_HARNESS: join(install, "current"),
				},
			});
			hosts.push(host);
			trustHome();
			const folder = join(sealed.home, "work");
			mkdirSync(folder, { recursive: true });
			const busy = await host.open(folder, {
				model: SCRIPTED,
				first: WAIT_A_WHILE,
			});
			await untilAnswered(
				"the conversation is on the mesh",
				async () => signature(busy.sessionId) !== "",
			);
			const address = signature(busy.sessionId);

			// The install moves under the run, and the release asks it to go.
			moveTo(install, "two");
			const released = await release([busy.sessionId], { offer: true });
			expect(
				released.code,
				`${released.out}\n${movesSaid()}\n${textOf(busy.file)}`,
			).toBe(0);
			expect(released.out).toContain("1 released");
			expect(await host.list(), "the host ends empty").toEqual([]);
			expect(offered().get(busy.sessionId), "it is offered").toMatchObject({
				address,
				released: { from: hostKey(sealed.realm, "background") },
			});

			const plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file: busy.file ?? "",
				cwd: folder,
			});
			plains.push(plain);
			await untilAnswered(
				`${busy.sessionId} runs in its one plain pi`,
				async () => {
					const now = presences().of(busy.sessionId);
					return now?.owner?.pid === plain.pid && !now?.hosted;
				},
			);
			await answers(
				busy.file ?? "",
				address,
				`${busy.sessionId} answers in plain pi`,
			);
		});
	},
	// One host, a 20-second run, perhaps a reload, a release, one plain pi, three round trips.
	ROUND_TRIP_MS * 5,
);

it(
	"E31: a folder its host left untrusted stays so in plain pi, which never asks",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			const host = await startHost({
				seal: sealed,
				engine: PI_ENGINE,
				kind: "background",
				env: { PI_HOST_PACKAGE_DIR: pi },
			});
			hosts.push(host);
			// Settings of its own, which pi loads only in a folder it trusts.
			const folder = join(realpathSync(sealed.home), "untrusted");
			mkdirSync(join(folder, ".pi"), { recursive: true });
			writeFileSync(join(folder, ".pi", "settings.json"), "{}\n");
			const one = await host.open(folder, { model: SCRIPTED });
			const address = signature(one.sessionId);
			await answers(one.file ?? "", address, `${address} answers hosted`);

			const released = await release([one.sessionId], { offer: true });
			expect(released.code, released.out).toBe(0);
			expect(await host.list(), "the host ends empty").toEqual([]);

			const plain = await startTerminalPi({
				seal: sealed,
				packageDir: pi,
				file: one.file ?? "",
				cwd: folder,
			});
			plains.push(plain);
			await untilAnswered(
				`${one.sessionId} runs in its one plain pi, never asking`,
				async () => {
					const now = presences().of(one.sessionId);
					return now?.owner?.pid === plain.pid && !now?.hosted;
				},
			);
			await answers(
				one.file ?? "",
				address,
				`${one.sessionId} answers in plain pi`,
			);
			expect(
				savedTrust(),
				"no decision is saved for the folder",
			).not.toHaveProperty([folder]);
		});
	},
	// One host, one open, a release, one plain pi, two round trips.
	ROUND_TRIP_MS * 4,
);
