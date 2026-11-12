/**
 * A plain pi as a window's holder keeps it, ready to move by /host (E13,
 * E17, E21), and what its log says after a point.
 *
 * Held means started with the holder's wake and next-command files, as
 * mycelium's hold sets them, and bare, taking no flag a restart would
 * lose, so the scripted model loads from the seal's settings.
 */

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../../lib/internal/record.ts";
import { textOf } from "./hosted-case.ts";
import type { Seal } from "./seal.ts";
import {
	SCRIPTED_PROVIDER,
	startTerminalPi,
	type TerminalPi,
} from "./terminal-pi.ts";

/**
 * Start a held plain pi under `sealed` on the pi in `packageDir`, in a
 * trusted folder `w` of the seal's home, its hold's files named after
 * `name`. The host must have started first, since its engine writes the
 * settings this adds the scripted model to.
 */
export async function startHeldPi(
	sealed: Seal,
	packageDir: string,
	name: string,
): Promise<TerminalPi> {
	const settings = join(sealed.home, ".pi", "agent", "settings.json");
	const written: unknown = JSON.parse(await readFile(settings, "utf8"));
	await writeFile(
		settings,
		JSON.stringify({
			...(isRecord(written) ? written : {}),
			extensions: [SCRIPTED_PROVIDER],
		}),
	);
	const cwd = join(sealed.home, "w");
	await mkdir(cwd, { recursive: true });
	await writeFile(
		join(sealed.home, ".pi", "agent", "trust.json"),
		JSON.stringify({ [await realpath(sealed.home)]: true }),
	);
	const hold = join(sealed.root, "hold");
	await mkdir(hold, { recursive: true });
	const pi = await startTerminalPi({
		seal: sealed,
		packageDir,
		cwd,
		env: {
			MYCELIUM_WAKE: join(hold, `${name}.wake`),
			MYCELIUM_AGAIN: join(hold, `${name}.again`),
		},
		bare: true,
	});
	await writeFile(join(hold, `${name}.json`), JSON.stringify({ pid: pi.pid }));
	return pi;
}

/** The words of the user messages and job results a log holds after `from`. */
export function saidAfter(file: string, from: number): string {
	return textOf(file)
		.slice(from)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line): string => {
			const entry: unknown = JSON.parse(line);
			if (!isRecord(entry)) return "";
			const message = isRecord(entry.message) ? entry.message : entry;
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part: unknown) =>
					isRecord(part) && typeof part.text === "string" ? part.text : "",
				)
				.join("");
		})
		.join("\n");
}
