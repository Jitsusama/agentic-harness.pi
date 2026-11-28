/**
 * A kept call outlives the pi that started it. pi's own spawn tracks
 * each shell it starts, and from 1.6 an interactive pi's quit, /host's
 * included, kills each one's process group. On 28 November E17 on
 * htt66 met it: the plain pi, with no pi-spawner, quit as it moved, and
 * its kept call's shell went with it, only `timeout`, in a group of its
 * own, left running (OSPHT4 [e2df4710]).
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMMAND_VARIABLE,
	KEEP_VARIABLE,
	KEEPING_STUB,
} from "../../../../extensions/shell-workflow/command-line.ts";
import { keptApart } from "../../../../lib/internal/shell/kept-apart.ts";
// pi exports none of its tracking; the file its bash imports is read
// here as it is, the one module pi's own spawn adds each shell to.
import { killTrackedDetachedChildren } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js";

let dir: string;
const running: number[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kept-apart-"));
});

afterEach(() => {
	writeFileSync(join(dir, "release"), "");
	for (const pid of running.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Ended already, as a passing case leaves it.
		}
	}
	rmSync(dir, { recursive: true, force: true });
});

/** Whether a process is still there. */
function alive(pid: number): boolean {
	return existsSync(`/proc/${pid}`);
}

/** Wait, a tenth of a second at a time, for `done` to hold. */
async function until(what: string, done: () => boolean): Promise<void> {
	for (let look = 0; look < 50; look++) {
		if (done()) return;
		await new Promise((settle) => setTimeout(settle, 100));
	}
	throw new Error(`waited 5 s for ${what}`);
}

/**
 * Start a kept call through `ops` that runs until the case releases it,
 * once its shell has said its pid.
 */
async function keptCall(
	ops: BashOperations,
	signal?: AbortSignal,
): Promise<{
	shell: number;
	end: Promise<{ exitCode: number | null }>;
	said: () => string;
}> {
	const keep = join(dir, "keep");
	let said = "";
	const end = ops.exec(KEEPING_STUB, dir, {
		onData: (data) => {
			said += data.toString("utf8");
		},
		...(signal ? { signal } : {}),
		env: {
			PATH: process.env.PATH ?? "",
			[COMMAND_VARIABLE]: `until [ -e '${join(dir, "release")}' ]; do sleep 0.1; done; echo kept-ended`,
			[KEEP_VARIABLE]: keep,
		},
	});
	// Read so a call that fails before its pid says why, not a wait.
	end.catch(() => undefined);
	await until("the kept shell's pid", () =>
		/^\d+\n$/.test(
			existsSync(`${keep}.pid`) ? readFileSync(`${keep}.pid`, "utf8") : "",
		),
	);
	const shell = Number(readFileSync(`${keep}.pid`, "utf8"));
	running.push(shell);
	return { shell, end, said: () => said };
}

describe("a kept call pi would start itself", () => {
	it("outlives pi killing the shells it tracks, as its quit does", async () => {
		const { shell, end, said } = await keptCall(
			keptApart(createLocalBashOperations()),
		);
		killTrackedDetachedChildren();
		// The kill is sent at once; a tenth of a second lets it land.
		await new Promise((settle) => setTimeout(settle, 100));
		expect(alive(shell), "the kept shell runs on").toBe(true);
		writeFileSync(join(dir, "release"), "");
		expect(await end).toEqual({ exitCode: 0 });
		expect(said()).toBe("kept-ended\n");
		expect(readFileSync(join(dir, "keep.end"), "utf8")).toBe("0\n");
	});

	it("is stopped whole when its call is stopped", async () => {
		const stopping = new AbortController();
		const { shell, end } = await keptCall(
			keptApart(createLocalBashOperations()),
			stopping.signal,
		);
		stopping.abort();
		await expect(end).rejects.toThrow("aborted");
		await until("the kept shell to end", () => !alive(shell));
	});

	it("is stopped whole when its time runs out", async () => {
		const ops = keptApart(createLocalBashOperations());
		const keep = join(dir, "keep");
		const end = ops.exec(KEEPING_STUB, dir, {
			onData: () => undefined,
			timeout: 0.5,
			env: {
				PATH: process.env.PATH ?? "",
				[COMMAND_VARIABLE]: "sleep 30",
				[KEEP_VARIABLE]: keep,
			},
		});
		await expect(end).rejects.toThrow("timeout:0.5");
		const shell = Number(readFileSync(`${keep}.pid`, "utf8"));
		await until("the kept shell to end", () => !alive(shell));
	});
});

describe("a command not kept", () => {
	it("is still pi's own to start", async () => {
		const started: string[] = [];
		const own: BashOperations = {
			exec: async (command) => {
				started.push(command);
				return { exitCode: 0 };
			},
		};
		await keptApart(own).exec("true", dir, {
			onData: () => undefined,
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(started).toEqual(["true"]);
	});
});
