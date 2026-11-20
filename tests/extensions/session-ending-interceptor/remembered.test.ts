/**
 * The machines the nodes named stay in their file, every one of them,
 * whether one process adds them or several add at once.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberMachines } from "../../../extensions/session-ending-interceptor/remembered.ts";

const MODULE = pathToFileURL(
	join(
		import.meta.dirname,
		"../../../extensions/session-ending-interceptor/remembered.ts",
	),
).href;

/** How many machines each writer adds, one read at a time. */
const EACH_ADDS = 150;

let scratch: string;
let file: string;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "remembered-"));
	file = join(scratch, "session-ending", "machines.json");
});
afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

const kept = (): string[] => JSON.parse(readFileSync(file, "utf8"));

/** A node process ready to add machines, and the word that starts it. */
interface Writer {
	ended: Promise<number | null>;
	go: () => void;
}

/**
 * A node process adding `prefix`-1 to `prefix`-EACH_ADDS, one at a time,
 * once told to go on its stdin, so that two writers start together
 * rather than one finishing while the other is still loading.
 */
function writer(prefix: string): Writer {
	const script = [
		`import { rememberMachines } from ${JSON.stringify(MODULE)};`,
		`await new Promise((go) => process.stdin.once("data", go));`,
		"process.stdin.pause();",
		`for (let i = 1; i <= ${EACH_ADDS}; i++)`,
		`  await rememberMachines(${JSON.stringify(file)}, [\`${prefix}-\${i}\`]);`,
	].join("\n");
	const child = spawn(
		process.execPath,
		["--input-type=module", "--no-warnings", "-e", script],
		{ stdio: ["pipe", "inherit", "inherit"] },
	);
	return {
		ended: new Promise((ended) => child.on("exit", ended)),
		go: () => child.stdin?.end("go\n"),
	};
}

describe("the machines kept", () => {
	it("keeps what one read names, beside what was kept", async () => {
		await rememberMachines(file, ["optimus"]);

		expect(await rememberMachines(file, ["equilibrius"])).toEqual([
			"optimus",
			"equilibrius",
		]);
		expect(kept()).toEqual(["optimus", "equilibrius"]);
	});

	it("loses none when two processes add at once", async () => {
		const writers = [writer("a"), writer("b")];
		for (const one of writers) one.go();
		const ended = await Promise.all(writers.map((one) => one.ended));

		expect(ended).toEqual([0, 0]);
		const all = kept();
		const missing = ["a", "b"]
			.flatMap((prefix) =>
				Array.from({ length: EACH_ADDS }, (_, i) => `${prefix}-${i + 1}`),
			)
			.filter((name) => !all.includes(name));
		expect(missing, "machines one writer dropped of the other's").toEqual([]);
	}, 60_000);

	it("writes past a lock a writer that died left behind", async () => {
		await rememberMachines(file, ["optimus"]);
		const lock = `${file}.lock`;
		writeFileSync(lock, "999999\n");
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(lock, longAgo, longAgo);

		await rememberMachines(file, ["equilibrius"]);

		expect(kept()).toEqual(["optimus", "equilibrius"]);
		expect(existsSync(lock), "the stale lock is gone once written").toBe(false);
	});

	it("leaves no temporary file behind when the write can't land", async () => {
		mkdirSync(file, { recursive: true });

		expect(await rememberMachines(file, ["optimus"])).toEqual(["optimus"]);
		expect(
			readdirSync(join(scratch, "session-ending")).filter((name) =>
				name.endsWith(".tmp"),
			),
			"temporary files left beside the list",
		).toEqual([]);
	});

	it("leaves no lock behind once it has written", async () => {
		await rememberMachines(file, ["optimus"]);

		expect(existsSync(`${file}.lock`), "no lock outlives the write").toBe(
			false,
		);
	});
});
