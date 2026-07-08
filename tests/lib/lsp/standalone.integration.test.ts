import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createStandaloneBackend,
	MissingServerError,
	type StandaloneBackend,
} from "../../../lib/lsp/index.js";

const repoRoot = resolve(__dirname, "..", "..", "..");
const tsserver = join(
	repoRoot,
	"node_modules",
	".bin",
	"typescript-language-server",
);
const hasServer = existsSync(tsserver);

/** Generous cap: a cold server spawn plus a large project build. */
const LIVE_TIMEOUT_MS = 45_000;

/**
 * Locate the 1-indexed line and 0-indexed byte column of the
 * first line containing `needle`, at the needle's own offset.
 */
function locate(
	path: string,
	needle: string,
): { line: number; character: number } {
	const lines = readFileSync(path, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const col = lines[i].indexOf(needle);
		if (col >= 0) return { line: i + 1, character: col };
	}
	throw new Error(`needle not found: ${needle}`);
}

// The standalone backend needs a real language server on disk;
// skip cleanly where one was not provisioned. Every op roots at
// this repo, so the whole suite shares one warm server.
describe.skipIf(!hasServer)("standalone backend (live server)", () => {
	let backend: StandaloneBackend;
	const offsets = join(repoRoot, "lib", "lsp", "offsets.ts");

	beforeAll(() => {
		const env = {
			...process.env,
			PATH: `${join(repoRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
		};
		backend = createStandaloneBackend({ env });
	});

	afterAll(async () => {
		await backend?.dispose();
	});

	it(
		"reports an error diagnostic for a type mismatch",
		async () => {
			// A throwaway file inside the repo's TS project, so the
			// warm server type-checks it and publishes the error.
			const broken = join(
				repoRoot,
				"lib",
				"lsp",
				`__diag_check_${process.pid}.ts`,
			);
			writeFileSync(
				broken,
				'const n: number = "not a number";\nexport default n;\n',
			);
			try {
				const diags = await backend.diagnostics(broken);
				expect(diags.some((d) => d.severity === "error")).toBe(true);
			} finally {
				rmSync(broken, { force: true });
			}
		},
		LIVE_TIMEOUT_MS,
	);

	it("binds one server per resolved root", () => {
		// Every op above roots at the repo, so the pool holds one.
		expect(backend.serverCount()).toBe(1);
	});

	it(
		"finds the definition of a symbol in this repo's own source",
		async () => {
			const target = {
				path: offsets,
				position: locate(offsets, "utf8ByteLength(ch"),
			};
			const locations = await backend.definition(target);
			expect(locations.length).toBeGreaterThan(0);
			expect(locations[0].path).toBe(offsets);
			const declLine = readFileSync(offsets, "utf8").split("\n")[
				locations[0].range.start.line - 1
			];
			expect(declLine).toContain("function utf8ByteLength");
		},
		LIVE_TIMEOUT_MS,
	);

	it(
		"finds references to an exported symbol across the root",
		async () => {
			const target = {
				path: offsets,
				position: locate(offsets, "export function byteToUtf16"),
			};
			const refs = await backend.references({
				path: target.path,
				position: {
					line: target.position.line,
					character: target.position.character + "export function ".length,
				},
			});
			expect(refs.length).toBeGreaterThan(1);
			expect(refs.some((r) => r.path.endsWith("document.ts"))).toBe(true);
		},
		LIVE_TIMEOUT_MS,
	);

	it("degrades to a clear message when no server handles the file", async () => {
		await expect(
			backend.diagnostics("/tmp/nowhere/file.rs"),
		).rejects.toBeInstanceOf(MissingServerError);
	});

	it(
		"renames a symbol across every file under the root and writes the edits",
		async () => {
			// An isolated project so the rename never touches real source.
			const dir = mkdtempSync(join(tmpdir(), "lsp-rename-"));
			writeFileSync(
				join(dir, "tsconfig.json"),
				JSON.stringify({ compilerOptions: {}, include: ["*.ts"] }),
			);
			const a = join(dir, "a.ts");
			const b = join(dir, "b.ts");
			writeFileSync(a, 'export const greeting = "hi";\n');
			writeFileSync(
				b,
				'import { greeting } from "./a";\nexport const msg = greeting + "!";\n',
			);
			const edit = await backend.rename(
				{ path: a, position: locate(a, "greeting") },
				"salutation",
			);
			expect(edit.changes.length).toBeGreaterThanOrEqual(2);
			expect(readFileSync(a, "utf8")).toContain("salutation");
			const updatedB = readFileSync(b, "utf8");
			expect(updatedB).toContain("salutation");
			expect(updatedB).not.toContain("greeting");
			rmSync(dir, { recursive: true, force: true });
		},
		LIVE_TIMEOUT_MS,
	);
});
