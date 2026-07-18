import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	DEFAULT_SERVERS,
	resolveBinary,
	resolveRoot,
	type ServerConfig,
	serversForFile,
	typescriptMajorAt,
} from "../../../lib/lsp/config.js";

const tmpRoots: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-config-"));
	tmpRoots.push(dir);
	return dir;
}
afterAll(() => {
	// Best-effort: the OS reaps its own tmp dir eventually.
});

describe("serversForFile", () => {
	it("matches the TypeScript server to a .ts file", () => {
		const matched = serversForFile("src/foo.ts");
		expect(matched.map((s) => s.name)).toContain("typescript");
	});

	it("returns nothing for an unhandled extension", () => {
		expect(serversForFile("main.rs")).toEqual([]);
	});

	it("skips a disabled server", () => {
		const servers: Record<string, ServerConfig> = {
			ts: { ...DEFAULT_SERVERS.typescript, disabled: true },
		};
		expect(serversForFile("foo.ts", servers)).toEqual([]);
	});
});

describe("resolveRoot", () => {
	it("walks up to the nearest ancestor holding a marker", () => {
		const root = tmp();
		writeFileSync(join(root, "tsconfig.json"), "{}");
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "file.ts"), "");
		expect(resolveRoot(join(nested, "file.ts"), ["tsconfig.json"])).toBe(root);
	});

	it("prefers the closest marker in a monorepo layout", () => {
		const repo = tmp();
		writeFileSync(join(repo, "package.json"), "{}");
		const pkg = join(repo, "packages", "inner");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), "{}");
		writeFileSync(join(pkg, "x.ts"), "");
		expect(resolveRoot(join(pkg, "x.ts"), ["package.json"])).toBe(pkg);
	});

	it("returns null when no marker is found", () => {
		const root = tmp();
		writeFileSync(join(root, "loose.ts"), "");
		expect(resolveRoot(join(root, "loose.ts"), ["go.mod"])).toBeNull();
	});
});

describe("resolveBinary", () => {
	it("finds a project-local bin ahead of PATH", () => {
		const root = tmp();
		const binDir = join(root, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		const bin = join(binDir, "faux-lsp");
		writeFileSync(bin, "#!/bin/sh\n");
		chmodSync(bin, 0o755);
		expect(resolveBinary("faux-lsp", root, { PATH: "" })).toBe(bin);
	});

	it("falls back to PATH when no local bin exists", () => {
		const pathDir = tmp();
		const bin = join(pathDir, "on-path-lsp");
		writeFileSync(bin, "#!/bin/sh\n");
		chmodSync(bin, 0o755);
		const from = tmp();
		expect(resolveBinary("on-path-lsp", from, { PATH: pathDir })).toBe(bin);
	});

	it("returns null when the command resolves nowhere", () => {
		const from = tmp();
		expect(resolveBinary("nope-not-here", from, { PATH: "" })).toBeNull();
	});
});

// Build a project root with an optional installed TypeScript version
// and a set of stub binaries under node_modules/.bin.
function tsProject(version: string | null, bins: readonly string[]): string {
	const root = tmp();
	if (version !== null) {
		const pkgDir = join(root, "node_modules", "typescript");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version }));
	}
	const binDir = join(root, "node_modules", ".bin");
	mkdirSync(binDir, { recursive: true });
	for (const bin of bins) {
		const path = join(binDir, bin);
		writeFileSync(path, "#!/bin/sh\n");
		chmodSync(path, 0o755);
	}
	return root;
}

describe("typescriptMajorAt", () => {
	it("reads the installed TypeScript major version", () => {
		expect(typescriptMajorAt(tsProject("7.0.2", []))).toBe(7);
		expect(typescriptMajorAt(tsProject("5.9.3", []))).toBe(5);
	});

	it("returns null when TypeScript is not installed", () => {
		expect(typescriptMajorAt(tmp())).toBeNull();
	});
});

describe("typescript server resolution", () => {
	const resolve = DEFAULT_SERVERS.typescript.resolve;
	const env = { PATH: "" };

	it("selects the native LSP for TypeScript 7 and newer", () => {
		const root = tsProject("7.0.2", ["tsc"]);
		expect(resolve?.(root, env)).toEqual({
			command: "tsc",
			args: ["--lsp", "--stdio"],
		});
	});

	it("selects the classic wrapper for older TypeScript when present", () => {
		const root = tsProject("5.9.3", ["typescript-language-server"]);
		expect(resolve?.(root, env)).toEqual({
			command: "typescript-language-server",
			args: ["--stdio"],
		});
	});

	it("returns null for older TypeScript with no classic wrapper", () => {
		const root = tsProject("5.9.3", ["tsc"]);
		expect(resolve?.(root, env)).toBeNull();
	});
});
