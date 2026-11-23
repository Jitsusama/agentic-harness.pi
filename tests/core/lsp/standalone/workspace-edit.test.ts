/**
 * A rename's workspace edit, laid on disk by pi for its server: a name
 * the server sends that is no file refuses the whole edit, and a write
 * that fails partway still tells the server of each file written, and
 * says which were.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorkspaceEdit } from "../../../../lib/core/lsp/standalone/workspace-edit.ts";

/** How many writes go through before one fails, when one is to. */
const failing = vi.hoisted(() => ({ after: Number.POSITIVE_INFINITY }));

vi.mock(
	"../../../../lib/core/lsp/standalone/judged-files.ts",
	async (original) => {
		const real =
			await original<
				typeof import("../../../../lib/core/lsp/standalone/judged-files.ts")
			>();
		return {
			...real,
			rewriteAt: (fd: number, text: string) => {
				if (failing.after-- <= 0) throw new Error("no space left");
				real.rewriteAt(fd, text);
			},
		};
	},
);

describe("a rename's edit laid on disk for its server", () => {
	let dir: string;
	let told: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-workspace-edit-"));
		told = [];
		failing.after = Number.POSITIVE_INFINITY;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const server = {
		name: "fake",
		refuses: undefined,
		tell: (path: string) => {
			told.push(path);
		},
	};

	/** An edit putting "renamed " at the start of each of `paths`. */
	const renaming = (...paths: string[]) => ({
		changes: Object.fromEntries(
			paths.map((path) => [
				path.includes(":") ? path : pathToFileURL(path).toString(),
				[
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 0 },
						},
						newText: "renamed ",
					},
				],
			]),
		),
	});

	it("writes none when the server names something that is no file", () => {
		const file = join(dir, "a.ts");
		writeFileSync(file, "x\n");

		expect(() =>
			applyWorkspaceEdit(renaming(file, "untitled:b.ts"), server),
		).toThrow(/^fake's rename wrote nothing: /);
		expect(readFileSync(file, "utf8")).toBe("x\n");
	});

	it("tells the server of each file written before one failed, and says which were", () => {
		const first = join(dir, "a.ts");
		const second = join(dir, "b.ts");
		writeFileSync(first, "x\n");
		writeFileSync(second, "x\n");
		failing.after = 1;

		expect(() => applyWorkspaceEdit(renaming(first, second), server)).toThrow(
			`fake's rename wrote 1 of 2 files (${first}) and failed at ${second}, which may be left part written: no space left`,
		);
		expect(readFileSync(first, "utf8")).toBe("renamed x\n");
		expect(told).toEqual([first]);
	});
});
