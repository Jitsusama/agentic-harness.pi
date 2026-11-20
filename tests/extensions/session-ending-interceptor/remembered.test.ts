/**
 * The machines the nodes named stay in their file, every one of them,
 * whether one process adds them or several add at once.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
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

/** A node process adding `prefix`-1 to `prefix`-EACH_ADDS, one at a time. */
function writer(prefix: string): Promise<number | null> {
	const script = [
		`import { rememberMachines } from ${JSON.stringify(MODULE)};`,
		`for (let i = 1; i <= ${EACH_ADDS}; i++)`,
		`  await rememberMachines(${JSON.stringify(file)}, [\`${prefix}-\${i}\`]);`,
	].join("\n");
	const child = spawn(
		process.execPath,
		["--input-type=module", "--no-warnings", "-e", script],
		{ stdio: "inherit" },
	);
	return new Promise((ended) => child.on("exit", ended));
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
		const ended = await Promise.all([writer("a"), writer("b")]);

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

	it("leaves no lock behind once it has written", async () => {
		await rememberMachines(file, ["optimus"]);

		expect(existsSync(`${file}.lock`), "no lock outlives the write").toBe(
			false,
		);
	});
});
