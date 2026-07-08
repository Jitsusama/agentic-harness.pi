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

/** Generous cap: a cold server spawn under CI load. */
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
// skip cleanly where one was not provisioned. Everything roots at
// one small temp project, so the server builds a tiny program and
// answers fast and deterministically, and the whole suite shares
// one warm server.
describe.skipIf(!hasServer)("standalone backend (live server)", () => {
	let backend: StandaloneBackend;
	let project: string;
	let lib: string;
	let use: string;

	beforeAll(() => {
		project = mkdtempSync(join(tmpdir(), "lsp-live-"));
		writeFileSync(
			join(project, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
		);
		writeFileSync(
			join(project, "package.json"),
			JSON.stringify({ name: "fix" }),
		);
		lib = join(project, "lib.ts");
		use = join(project, "use.ts");
		writeFileSync(
			lib,
			'export function greeting(name: string): string {\n\treturn "hi " + name;\n}\n',
		);
		writeFileSync(
			use,
			'import { greeting } from "./lib";\nexport const msg = greeting("world");\n',
		);
		const env = {
			...process.env,
			PATH: `${join(repoRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
		};
		backend = createStandaloneBackend({ env });
	});

	afterAll(async () => {
		await backend?.dispose();
		if (project) rmSync(project, { recursive: true, force: true });
	});

	it(
		"reports an error diagnostic for a type mismatch",
		async () => {
			const broken = join(project, "broken.ts");
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
		// Every op roots at the one temp project, so the pool holds one.
		expect(backend.serverCount()).toBe(1);
	});

	it(
		"finds the definition of a symbol across the project",
		async () => {
			const locations = await backend.definition({
				path: use,
				position: locate(use, "greeting("),
			});
			expect(locations.length).toBeGreaterThan(0);
			expect(locations[0].path).toBe(lib);
		},
		LIVE_TIMEOUT_MS,
	);

	it(
		"finds references to an exported symbol across the root",
		async () => {
			const refs = await backend.references({
				path: lib,
				position: locate(lib, "greeting"),
			});
			expect(refs.length).toBeGreaterThan(1);
			expect(refs.some((r) => r.path === use)).toBe(true);
		},
		LIVE_TIMEOUT_MS,
	);

	it(
		"renames a symbol across every file under the root and writes the edits",
		async () => {
			const edit = await backend.rename(
				{ path: lib, position: locate(lib, "greeting") },
				"salutation",
			);
			expect(edit.changes.length).toBeGreaterThanOrEqual(2);
			expect(readFileSync(lib, "utf8")).toContain("salutation");
			const updatedUse = readFileSync(use, "utf8");
			expect(updatedUse).toContain("salutation");
			expect(updatedUse).not.toContain("greeting");
		},
		LIVE_TIMEOUT_MS,
	);

	it("degrades to a clear message when no server handles the file", async () => {
		await expect(
			backend.diagnostics("/tmp/nowhere/file.rs"),
		).rejects.toBeInstanceOf(MissingServerError);
	});
});
