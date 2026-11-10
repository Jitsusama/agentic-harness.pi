/**
 * A mycelium node of the sealed realm, run in the seal as its own
 * process, alone: it links with nothing unless told to. It learns the
 * sessions from the presence files the harness writes under the seal's
 * state folder, and writes a steer into the inbox the harness reads
 * there, so what it reports and steers is the hosted conversations'.
 * Asked through the `mycelium` command as the person asks it.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOST_PI_REQUIRED } from "./host-pi.ts";
import { untilAnswered } from "./hosted-case.ts";
import { SEALED_REALM, type Seal } from "./seal.ts";

const run = promisify(execFile);

/** How long a node may take to bind its socket and answer. */
const NODE_WAIT_MS = 10_000;

/** How long one `mycelium` command may take. */
const ASK_MS = 10_000;

/** One session as the node reports it: its address and its state. */
export interface NodeSession {
	readonly address: string;
	readonly state: string;
}

/** A sealed node, what it says, and how to stop it. */
export interface SealedNode {
	/** Every session the node knows of, as `mycelium sessions` prints them. */
	sessions(): Promise<readonly NodeSession[]>;
	/** Steer `text` to the session going by `address`, as the person would. */
	steer(address: string, text: string): Promise<void>;
	/** Stop the node, as systemd does. */
	stop(): Promise<void>;
	/** What the node wrote to its error stream. */
	errors(): string;
}

/** What finds no mycelium, and how to get one. */
export function myceliumMissing(seal: Seal): string {
	return `No mycelium on the PATH a sealed host runs with (${seal.env.PATH}): put core.nix's mycelium on it`;
}

/**
 * Whether a sealed node can run here; where it can't, the check is
 * skipped saying why, or failed where PI_HOST_REQUIRED asks for it.
 */
export async function nodeFor(
	seal: Seal,
	skip: (note: string) => never,
): Promise<void> {
	try {
		await run("mycelium", ["--version"], { env: seal.env, timeout: ASK_MS });
	} catch {
		// Not found, or not runnable: said below as a skip or a failure.
		if (process.env[HOST_PI_REQUIRED]) throw new Error(myceliumMissing(seal));
		skip(myceliumMissing(seal));
	}
}

/** Start a sealed node, answering once `mycelium sessions` answers. */
export async function startNode(seal: Seal): Promise<SealedNode> {
	const child: ChildProcess = spawn(
		"mycelium",
		["--realm", SEALED_REALM, "node", "--machine", "sealed"],
		{ env: seal.env, stdio: ["ignore", "ignore", "pipe"] },
	);
	let errors = "";
	child.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const ask = async (args: readonly string[], input?: string) => {
		const asking = run("mycelium", ["--realm", SEALED_REALM, ...args], {
			env: seal.env,
			timeout: ASK_MS,
		});
		if (input !== undefined) {
			asking.child.stdin?.end(input);
		}
		return (await asking).stdout;
	};
	const sessions = async (): Promise<readonly NodeSession[]> =>
		sessionsIn(await ask(["sessions"]));
	const socket = join(
		seal.env.XDG_RUNTIME_DIR ?? "",
		"mycelium",
		`${SEALED_REALM}.sock`,
	);
	await untilAnswered(
		"the sealed node answers",
		async () => {
			if (!existsSync(socket)) return false;
			try {
				await sessions();
				return true;
			} catch {
				// Bound but not answering yet: asked again.
				return false;
			}
		},
		NODE_WAIT_MS,
	).catch((error: unknown) => {
		child.kill("SIGKILL");
		throw new Error(`${String(error)}: ${errors}`);
	});
	return {
		sessions,
		steer: async (address, text) => {
			await ask(["steer", address], JSON.stringify({ text }));
		},
		stop: async () => {
			child.kill("SIGTERM");
			await exited;
		},
		errors: () => errors,
	};
}

/** The sessions in what `mycelium sessions` printed. */
function sessionsIn(printed: string): readonly NodeSession[] {
	const said: unknown = JSON.parse(printed);
	const listed = dig(said, "Ok", "Sessions");
	if (!Array.isArray(listed)) throw new Error(`the node said ${printed}`);
	return listed.flatMap((one: unknown) => {
		const address = dig(one, "address");
		const state = dig(one, "state");
		return typeof address === "string" && typeof state === "string"
			? [{ address, state }]
			: [];
	});
}

/** The value at `path` in `value`, or nothing. */
function dig(value: unknown, ...path: readonly string[]): unknown {
	let at = value;
	for (const key of path) {
		if (typeof at !== "object" || at === null) return undefined;
		at = Reflect.get(at, key);
	}
	return at;
}
