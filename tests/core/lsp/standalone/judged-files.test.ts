/**
 * The files a language server names, opened by pi and judged as the
 * files they are: by the path the kernel gives the descriptor where it
 * gives one, and elsewhere by the path's real target, held to being
 * the file opened, with every write refused.
 */
import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	openJudged,
	type Refuses,
	textAt,
} from "../../../../lib/core/lsp/standalone/judged-files.ts";

/** Whether this kernel names its descriptors' files. */
const namesDescriptors = existsSync("/proc/self/fd");

describe("a file pi opens for a fenced server", () => {
	let inside: string;
	let away: string;

	beforeEach(() => {
		inside = realpathSync(mkdtempSync(join(tmpdir(), "judged-inside-")));
		away = realpathSync(mkdtempSync(join(tmpdir(), "judged-away-")));
		writeFileSync(join(inside, "a.ts"), "inside\n");
		writeFileSync(join(away, "key"), "secret\n");
		symlinkSync(join(away, "key"), join(inside, "leads-out.ts"));
	});

	afterEach(() => {
		rmSync(inside, { recursive: true, force: true });
		rmSync(away, { recursive: true, force: true });
	});

	/** The fence of a server whose folder is `inside`. */
	const outside: Refuses = (_use, path) =>
		path.startsWith(`${inside}/`) ? undefined : `${path} is outside`;

	/** `path`'s text, opened as `use` and judged, or why it was refused. */
	const opened = (
		path: string,
		use: "read" | "write",
		descriptors?: string,
	): string => {
		let fd: number;
		try {
			fd = openJudged(path, use, outside, descriptors);
		} catch (error) {
			return `refused: ${error instanceof Error ? error.message : String(error)}`;
		}
		try {
			return textAt(fd);
		} finally {
			closeSync(fd);
		}
	};

	it("opens one the fence lets through, as it is", () => {
		expect(opened(join(inside, "a.ts"), "read")).toBe("inside\n");
	});

	it("judges the path before it opens it, so it opens nothing the fence closes", () => {
		const missing = join(away, "missing");

		expect(opened(missing, "read")).toBe(`refused: ${missing} is outside`);
		expect(opened(missing, "write")).toBe(`refused: ${missing} is outside`);
	});

	it("writes no file with another name, which the fence never judged, but reads one", () => {
		const second = join(inside, "second.ts");
		linkSync(join(inside, "a.ts"), second);

		expect(opened(second, "write")).toBe(
			`refused: ${second} has another name, which the fence didn't judge, so pi writes it for no fenced server`,
		);
		expect(opened(second, "read")).toBe("inside\n");
	});

	it("uses no file larger than pi holds whole for a fenced server", () => {
		const large = join(inside, "large.ts");
		writeFileSync(large, "");
		truncateSync(large, 32 * 1024 * 1024 + 1);

		expect(opened(large, "read")).toBe(
			`refused: ${large} is larger than the 32 MiB pi reads or writes for a fenced server`,
		);
	});

	it("reads no more than pi holds whole of a file that grew once it was opened", () => {
		const growing = join(inside, "growing.ts");
		writeFileSync(growing, "small\n");
		const fd = openJudged(growing, "read", outside);
		try {
			truncateSync(growing, 32 * 1024 * 1024 + 1);

			expect(() => textAt(fd)).toThrow(
				"runs past the 32 MiB pi reads or writes for a language server",
			);
		} finally {
			closeSync(fd);
		}
	});

	it("opens no pipe where no fence judges the path first, without waiting on it", () => {
		const pipe = join(inside, "unjudged-pipe.ts");
		execFileSync("mkfifo", [pipe]);

		expect(() => openJudged(pipe, "read", undefined)).toThrow(
			`${pipe} isn't a file`,
		);
	});

	it("opens nothing that isn't a plain file, a pipe left where a file was included, without waiting on it", () => {
		const pipe = join(inside, "pipe.ts");
		execFileSync("mkfifo", [pipe]);
		mkdirSync(join(inside, "folder.ts"));

		expect(opened(pipe, "read")).toBe(`refused: ${pipe} isn't a file`);
		expect(opened(join(inside, "folder.ts"), "read")).toBe(
			`refused: ${join(inside, "folder.ts")} isn't a file`,
		);
	});

	it.runIf(namesDescriptors)(
		"judges the file the kernel says it opened, not the path, so a link leading out is refused either way",
		() => {
			const link = join(inside, "leads-out.ts");

			expect(opened(link, "read")).toBe(
				`refused: ${join(away, "key")} is outside`,
			);
			expect(opened(link, "write")).toBe(
				`refused: ${join(away, "key")} is outside`,
			);
		},
	);

	describe("where the kernel names no descriptor's file", () => {
		let none: string;

		beforeEach(() => {
			none = join(inside, "no-descriptors");
		});

		it("refuses every write, since pi can't tell which file it opened", () => {
			const file = join(inside, "a.ts");

			expect(opened(file, "write", none)).toBe(
				`refused: pi can't tell here which file it opened at ${file}, so it writes none a fenced server names`,
			);
		});

		it("reads a file by its real target, so a link leading out is refused", () => {
			expect(opened(join(inside, "a.ts"), "read", none)).toBe("inside\n");
			expect(opened(join(inside, "leads-out.ts"), "read", none)).toBe(
				`refused: ${join(away, "key")} is outside`,
			);
		});
	});
});
