/**
 * A host case marked as one platform's alone names Linux.
 *
 * `itOnlyOn` (tests/host/end-to-end/support/only-on.mts) skips a case on
 * every platform but the one it names, and `pnpm test:host`'s reporter
 * and the proof's judge let such a skip by only for a case Linux runs,
 * skipped on a Mac (LINUX_ONLY_ON_A_MAC). Optimus, on Linux, is the only
 * platform whose run clears a merge, and every case must run there, so a
 * case written `itOnlyOn("darwin", ...)` would fail that gate; it is
 * refused here first, saying the file and line, so whoever is turning
 * test:host green is told before the gate tells them. `onlyOnBody`, the
 * body `itOnlyOn` registers, is held the same, since a case can be
 * written with it directly.
 *
 * Only a call whose first argument is the word "linux" itself passes: a
 * variable or an expression could name any platform. Two files are let
 * by: only-on.mts, where `itOnlyOn` hands `onlyOnBody` the platform it
 * was given, and only-on.test.ts, which proves `itOnlyOn` itself on
 * whatever platform runs it, in the unit lane `pnpm test:host` never runs.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LINUX_ONLY_ON_A_MAC } from "../../../host/service/proof.ts";
import { packageFiles } from "./package-files.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The test files read: every .ts and .mts file under tests/. */
const TEST_FILE = /^tests\/.*\.m?ts$/;

/** The helpers' own file, and the one proving them, as the header says. */
const THE_HELPERS: ReadonlySet<string> = new Set([
	"tests/host/end-to-end/support/only-on.mts",
	"tests/host/end-to-end/support/only-on.test.ts",
]);

/**
 * A call of either helper, but not its definition, and its first
 * argument, up to the comma or bracket closing it.
 */
const CALL = /(?<!function\s+)\b(?:itOnlyOn|onlyOnBody)\(\s*([^,)]*?)\s*[,)]/g;

/** How long a read of every file may take on a busy machine. */
const WALK = { timeout: 60_000 };

/** Whether a call's first argument is the word Linux's name is, quoted. */
function namesLinux(argument: string): boolean {
	const word = LINUX_ONLY_ON_A_MAC.onlyOn;
	return [`"${word}"`, `'${word}'`, `\`${word}\``].includes(argument);
}

/** The lines, counted from 1, of each call in some source naming anything but Linux. */
function otherPlatforms(text: string): number[] {
	return [...text.matchAll(CALL)]
		.filter((found) => !namesLinux(found[1] ?? ""))
		.map((found) => text.slice(0, found.index).split("\n").length);
}

describe("host cases marked as one platform's", () => {
	it("tell a call naming Linux from one naming anything else", () => {
		// A matcher that finds nothing passes everything. This is the check
		// that it finds what it is meant to and lets the rest by.
		expect(
			otherPlatforms('itOnlyOn("linux", "it reads /proc")("holds", fn);\n'),
			"Linux passes",
		).toEqual([]);
		expect(
			otherPlatforms(
				"const on = itOnlyOn('linux', why);\nitOnlyOn(\n\t`linux`,\n\twhy,\n);\n",
			),
			"in any quotes, across lines too",
		).toEqual([]);
		expect(
			otherPlatforms('itOnlyOn("darwin", "it reads the keychain");\n'),
			"a Mac is found",
		).toEqual([1]);
		expect(
			otherPlatforms(
				'const a = 1;\nitOnlyOn("win32", why)(name, fn);\nitOnlyOn("never", why);\n',
			),
			"any other platform, or none, is found on its line",
		).toEqual([2, 3]);
		expect(
			otherPlatforms(
				"itOnlyOn(platform, why);\nitOnlyOn(process.platform, why);\nitOnlyOn();\n",
			),
			"a variable, an expression or nothing names no platform for certain",
		).toEqual([1, 2, 3]);
		expect(
			otherPlatforms(
				'it(name, onlyOnBody("darwin", why, fn));\nit(name, onlyOnBody("linux", why, fn, "darwin"));\n',
			),
			"a body written with onlyOnBody is held the same",
		).toEqual([1]);
		expect(
			otherPlatforms(
				"export function itOnlyOn(platform: NodeJS.Platform, why: string) {\nexport function onlyOnBody(\n\tplatform,\n",
			),
			"a definition is no call",
		).toEqual([]);
	});

	it("name only Linux", WALK, () => {
		const others = packageFiles(ROOT)
			.filter((file) => TEST_FILE.test(file))
			// This file's own examples name other platforms on purpose.
			.filter((file) => file !== relative(ROOT, import.meta.filename))
			.filter((file) => !THE_HELPERS.has(file))
			.flatMap((file) =>
				otherPlatforms(readFileSync(join(ROOT, file), "utf8")).map(
					(line) => `${file}:${line}`,
				),
			);
		expect(
			others,
			`these mark a host case as only another platform's than ${LINUX_ONLY_ON_A_MAC.onlyOn}, which optimus's gate refuses, since every case must run on the Linux run that clears a merge: make the case run on ${LINUX_ONLY_ON_A_MAC.onlyOn}, or mark it itOnlyOn("${LINUX_ONLY_ON_A_MAC.onlyOn}", why) if only ${LINUX_ONLY_ON_A_MAC.onlyOn} can run it`,
		).toEqual([]);
	});
});
