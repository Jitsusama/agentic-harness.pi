import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	globArgs,
	grepArgs,
	investigationTools,
	resolveWithinRoot,
} from "../../../extensions/advisor/tools.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "advisor-root-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveWithinRoot", () => {
	it("allows a path inside the root", () => {
		expect(resolveWithinRoot(root, "sub/file.ts")).toBe(
			join(root, "sub/file.ts"),
		);
	});

	it("refuses an absolute path outside the root", () => {
		expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(/escapes/);
	});

	it("refuses a parent-directory climb", () => {
		expect(() => resolveWithinRoot(root, "../../.env")).toThrow(/escapes/);
	});
});

describe("grepArgs", () => {
	it("binds the pattern as a flag value behind a terminator", () => {
		const args = grepArgs("--pre=/bin/sh", "target");
		// The pattern must ride --regexp (not be a bare positional),
		// and a -- must precede the path, so neither is parsed as a flag.
		const rx = args.indexOf("--regexp");
		expect(rx).toBeGreaterThanOrEqual(0);
		expect(args[rx + 1]).toBe("--pre=/bin/sh");
		expect(args).toContain("--");
		expect(args.indexOf("--")).toBeGreaterThan(rx + 1);
		expect(args[args.length - 1]).toBe("target");
		// No bare positional that starts with a dash.
		expect(args.filter((a) => a === "--pre=/bin/sh")).toHaveLength(1);
	});
});

describe("globArgs", () => {
	it("binds the pattern as the --glob value", () => {
		const args = globArgs("--pre=x");
		const g = args.indexOf("--glob");
		expect(g).toBeGreaterThanOrEqual(0);
		expect(args[g + 1]).toBe("--pre=x");
	});
});

describe("read_file tool", () => {
	function readTool() {
		const tool = investigationTools(root).find((t) => t.name === "read_file");
		if (!tool) throw new Error("read_file tool missing");
		return tool;
	}

	it("refuses to read outside the root", async () => {
		const out = await readTool().execute({ path: "/etc/hosts" });
		expect(out).toMatch(/escapes/);
	});

	it("reads a contained file", async () => {
		writeFileSync(join(root, "a.txt"), "line one\nline two");
		const out = await readTool().execute({ path: "a.txt" });
		expect(out).toContain("line one");
		expect(out).toContain("line two");
	});

	it("clamps output that runs past the cap", async () => {
		writeFileSync(join(root, "big-line.txt"), "x".repeat(5000));
		const out = await readTool().execute({ path: "big-line.txt" });
		expect(out).toContain("... (truncated)");
	});

	it("refuses a non-regular file", async () => {
		mkdirSync(join(root, "adir"));
		const out = await readTool().execute({ path: "adir" });
		expect(out).toMatch(/not a regular file/);
	});

	it("refuses a file over the read-size cap", async () => {
		writeFileSync(join(root, "huge.txt"), "x".repeat(1_000_001));
		const out = await readTool().execute({ path: "huge.txt" });
		expect(out).toMatch(/too large/);
	});
});
