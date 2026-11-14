/**
 * Every child process this process starts while it is watched, and how.
 *
 * A host runs every conversation on one loop, so a child process one of
 * them starts with a blocking call (spawnSync, execFileSync, execSync)
 * holds every other conversation until it exits: in a soak of twelve on
 * 13 November those calls cost a turn 903 ms. Each function of
 * node:child_process is wrapped while watched, its calls passed straight
 * through, and the module's ES bindings are brought in line so a file
 * that imported a name sees the wrapper as one that reads the object
 * does. Plain TypeScript node can run with its types stripped, since the
 * engine's fixtures run it so.
 */

import { createRequire, syncBuiltinESMExports } from "node:module";

/** The calls that hold the loop until their child exits. */
export const BLOCKING = ["spawnSync", "execFileSync", "execSync"] as const;

/** The calls that start a child and return at once. */
export const STARTING = ["spawn", "execFile", "exec", "fork"] as const;

type How = (typeof BLOCKING)[number] | (typeof STARTING)[number];

const holding: ReadonlySet<How> = new Set(BLOCKING);

/** One child process started while watched. */
export interface Started {
	/** The child_process function it was started with. */
	readonly how: How;
	/** The program or command line it ran. */
	readonly program: string;
	/** The frames of the package's own code that started it, innermost first. */
	readonly from: readonly string[];
}

/** A watch over child processes, until it is stopped. */
export interface SpawnWatch {
	/** What was started so far. */
	readonly started: readonly Started[];
	/** Those started with a call that holds the loop. */
	blocking(): Started[];
	/** Put node:child_process back as it was. */
	stop(): void;
}

const childProcess: Record<How, (...args: unknown[]) => unknown> =
	createRequire(import.meta.url)("node:child_process");

/** How many of the package's frames to keep for a call. */
const FRAMES = 6;

/** Watch the child processes this process starts, until stopped. */
export function watchSpawns(): SpawnWatch {
	const started: Started[] = [];
	const originals = new Map<How, (...args: unknown[]) => unknown>();
	for (const how of [...BLOCKING, ...STARTING]) {
		const original = childProcess[how];
		originals.set(how, original);
		childProcess[how] = function watched(this: unknown, ...args: unknown[]) {
			started.push({ how, program: String(args[0]), from: ownFrames() });
			return original.apply(this, args);
		};
	}
	syncBuiltinESMExports();
	return {
		started,
		blocking: () => started.filter((one) => holding.has(one.how)),
		stop() {
			for (const [how, original] of originals) childProcess[how] = original;
			syncBuiltinESMExports();
		},
	};
}

/** The frames of the stack that are not node's, this file's or a dependency's. */
function ownFrames(): string[] {
	const trace = new Error("where a child was started").stack ?? "";
	const stack = trace.split("\n").slice(1);
	return stack
		.map((line) => line.trim().replace(/^at /, ""))
		.filter(
			(line) =>
				!line.includes("node:") &&
				!line.includes("node_modules") &&
				!line.includes("tests/support/spawns.ts"),
		)
		.slice(0, FRAMES);
}
