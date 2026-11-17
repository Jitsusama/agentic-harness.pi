/**
 * The quest lock folder the fence lets through its empty runtime folder,
 * so a fenced writer and one outside take the same lock on a quest: read
 * off fenceArgs, then through a real bubblewrap, with a fenced writer and
 * one outside bumping one counter at once. The bubblewrap cases skip only
 * where no bubblewrap can make a namespace, as inside another sandbox.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fenceArgs } from "../../../../lib/internal/fence/fence.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

/** The quest lock, which each writer loads as pi does. */
const QUEST_IO = new URL(
	"../../../../lib/internal/quest/io.ts",
	import.meta.url,
).pathname;

/** Bumps the quest's counter, under its lock, as many times as it is told. */
const WRITER = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [io, run, quest, times, name, other] = process.argv.slice(2);
const { atomicWriteFile, useRunFolderForTests, withQuestLock } = await import(io);
useRunFolderForTests(run);
const counter = join(quest, "counter");
// Starts only once the other writer is ready too: a fenced one takes
// longer to start, and two writers that never overlap prove nothing.
writeFileSync(join(quest, "..", "ready-" + name), "");
const deadline = Date.now() + 20000;
while (!existsSync(join(quest, "..", "ready-" + other)) && Date.now() < deadline) {}
try {
	for (let bump = 0; bump < Number(times); bump++) {
		withQuestLock(quest, () => {
			const seen = Number(readFileSync(counter, "utf8"));
			// Holds the lock a moment, so two writers without one overlap.
			const until = Date.now() + 1;
			while (Date.now() < until) {}
			atomicWriteFile(counter, String(seen + 1));
		});
	}
} catch (error) {
	process.stderr.write(String(error instanceof Error ? error.message : error));
	process.exit(2);
}
`;

/** How many times each writer bumps the counter. */
const BUMPS = 300;

let base = "";
let home = "";
let run = "";
let folder = "";
let quest = "";
let servers: Server[] = [];

/** A socket listening at `path`, closed after the test. */
async function listen(path: string): Promise<void> {
	const server = createServer((client) => client.end());
	servers.push(server);
	await new Promise<void>((settle) => server.listen(path, settle));
}

beforeEach(async () => {
	// Not resolved, since a Unix socket's path may be at most 107 bytes
	// and a temporary folder can sit behind a long link.
	base = mkdtempSync(join(tmpdir(), "fql-"));
	home = join(base, "home");
	run = join(base, "run");
	folder = join(run, "agentic-harness.pi", "quest-locks");
	quest = join(base, "quests", "QEST-20261117-FQL001");
	mkdirSync(home);
	mkdirSync(run, { mode: 0o700 });
	mkdirSync(quest, { recursive: true });
	writeFileSync(join(quest, "counter"), "0");
	await listen(join(run, "bus"));
});

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((settle) => server.close(() => settle())),
		),
	);
	servers = [];
	rmSync(base, { recursive: true, force: true });
});

/** Where in `args` the words `words` begin, in order, or -1. */
function at(args: readonly string[], ...words: string[]): number {
	return args.findIndex((_, start) =>
		words.every((word, offset) => args[start + offset] === word),
	);
}

/** Makes the lock folder a link to another folder, as nothing of pi's does. */
function linkTheFolder(): string {
	const elsewhere = join(base, "elsewhere");
	mkdirSync(elsewhere);
	mkdirSync(join(run, "agentic-harness.pi"), { recursive: true });
	symlinkSync(elsewhere, folder);
	return elsewhere;
}

describe("the quest lock folder in fenceArgs", () => {
	it("binds it back writable after the runtime folder is emptied, making it first", () => {
		const args = fenceArgs({ home, runtimeDir: run });
		const emptied = at(args, "--tmpfs", run);
		const bound = at(args, "--bind", folder, folder);
		expect(emptied, "the runtime folder is emptied").toBeGreaterThan(-1);
		expect(bound, "the lock folder is bound after it").toBeGreaterThan(emptied);
		expect(statSync(folder).mode & 0o777).toBe(0o700);
	});

	it("binds nothing else of the runtime folder writable", () => {
		const args = fenceArgs({ home, runtimeDir: run });
		const writable = args
			.map((word, index) => (word === "--bind" ? args[index + 1] : undefined))
			.filter((path) => path?.startsWith(`${run}/`));
		expect(writable).toEqual([folder]);
	});

	it.each([
		["a link", () => void linkTheFolder()],
		[
			"open to others",
			() => mkdirSync(folder, { recursive: true, mode: 0o755 }),
		],
		[
			"a file",
			() => {
				mkdirSync(join(run, "agentic-harness.pi"));
				writeFileSync(folder, "");
			},
		],
	])(
		"never binds it where it is %s, leaving an empty file there",
		(_, make) => {
			make();
			const args = fenceArgs({ home, runtimeDir: run });
			expect(at(args, "--bind", folder, folder)).toBe(-1);
			expect(at(args, "--ro-bind", "/dev/null", folder)).toBeGreaterThan(
				at(args, "--tmpfs", run),
			);
		},
	);

	it("binds nothing for it where the runtime folder holds no session bus", async () => {
		await Promise.all(
			servers.map(
				(server) => new Promise<void>((settle) => server.close(() => settle())),
			),
		);
		servers = [];
		const args = fenceArgs({ home, runtimeDir: run });
		expect(
			args.filter((word) => word.startsWith(folder)),
			"no word names the lock folder",
		).toEqual([]);
		expect(existsSync(folder), `${folder} isn't made`).toBe(false);
	});
});

describe.skipIf(bwrap === undefined)(
	"the quest lock folder through a real bubblewrap",
	() => {
		/** The fence's words around `command`, as a command is fenced. */
		const fenced = (command: readonly string[]): string[] => [
			"--unshare-user",
			...fenceArgs({ home, runtimeDir: run }),
			...command,
		];

		/** Whether `script` succeeds as a fenced command. */
		const fencedShell = (script: string): boolean =>
			spawnSync(bwrap ?? "bwrap", fenced(["sh", "-c", script])).status === 0;

		/** Runs the writer, fenced or not; resolves to its exit and what it said. */
		function writer(
			inFence: boolean,
		): Promise<{ code: number | null; said: string }> {
			const script = join(base, "writer.mts");
			writeFileSync(script, WRITER);
			const node = [
				process.execPath,
				"--experimental-strip-types",
				"--no-warnings",
				script,
				QUEST_IO,
				run,
				quest,
				String(BUMPS),
				inFence ? "inside" : "outside",
				inFence ? "outside" : "inside",
			];
			const [program, ...args] = inFence
				? [bwrap ?? "bwrap", ...fenced(node)]
				: node;
			const child = spawn(program ?? "bwrap", args, {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let said = "";
			child.stderr.on("data", (chunk) => {
				said += String(chunk);
			});
			return new Promise((settle) =>
				child.on("close", (code) => settle({ code, said })),
			);
		}

		it("hides the bus and the display's socket but lets the lock folder through", async () => {
			await listen(join(run, "wayland-0"));
			expect(
				fencedShell(`test ! -e '${run}/bus' && test ! -e '${run}/wayland-0'`),
				"the bus or the display's socket is seen inside",
			).toBe(true);
			expect(
				fencedShell(`touch '${folder}/made-inside'`),
				"the lock folder can't be written inside",
			).toBe(true);
			expect(readdirSync(folder)).toEqual(["made-inside"]);
		});

		it("never lets a link's folder through", () => {
			const elsewhere = linkTheFolder();
			fencedShell(`touch '${folder}/made-inside'`);
			expect(readdirSync(elsewhere)).toEqual([]);
		});

		it("keeps a fenced writer and one outside from writing a quest together", async () => {
			const [inside, outside] = await Promise.all([
				writer(true),
				writer(false),
			]);
			expect(inside).toEqual({ code: 0, said: "" });
			expect(outside).toEqual({ code: 0, said: "" });
			expect(readFileSync(join(quest, "counter"), "utf8")).toBe(
				String(2 * BUMPS),
			);
		}, 60_000);

		it("refuses a fenced writer the quest where the folder wasn't let through", async () => {
			linkTheFolder();
			// Alone, so it needn't wait for a writer outside.
			writeFileSync(join(quest, "..", "ready-outside"), "");
			const inside = await writer(true);
			expect(inside.code).toBe(2);
			expect(inside.said).toMatch(/fence/);
			expect(readFileSync(join(quest, "counter"), "utf8")).toBe("0");
		}, 60_000);
	},
);
