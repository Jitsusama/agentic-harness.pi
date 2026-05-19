import { describe, expect, it } from "vitest";
import {
	inferFiletype,
	parsePrFileUri,
	prFileUri,
	resolvePrFile,
} from "../../../extensions/pr-workflow/buffer.js";

describe("parsePrFileUri", () => {
	it("parses a typical URI with a nested path", () => {
		// The most common shape: nvim opens
		// pi://pr/<owner>/<repo>/<number>/file/<sha>/<path>
		// where the path keeps its slashes verbatim.
		const parsed = parsePrFileUri(
			"pi://pr/Shopify/world/12345/file/abc1234/src/handlers/foo.ts",
		);
		expect(parsed).toEqual({
			scheme: "pr-file",
			owner: "Shopify",
			repo: "world",
			number: 12345,
			sha: "abc1234",
			path: "src/handlers/foo.ts",
		});
	});

	it("decodes percent-encoded characters in the path", () => {
		// Agents may URL-encode path components that contain
		// special characters. The parser must decode them so
		// downstream fetches use the real filename.
		const parsed = parsePrFileUri(
			"pi://pr/owner/repo/1/file/sha/path%20with%20space.md",
		);
		expect(parsed?.path).toBe("path with space.md");
	});

	it("returns null for URIs with a different scheme", () => {
		// A handler that doesn't recognize the URI must say so
		// rather than guess; the dispatcher routes elsewhere.
		expect(parsePrFileUri("pi://other/foo")).toBeNull();
		expect(parsePrFileUri("file:///etc/passwd")).toBeNull();
		expect(parsePrFileUri("pi://pr/owner/repo/1/diff/sha/foo.ts")).toBeNull();
	});

	it("returns null when the PR number isn't numeric", () => {
		// The number is the public identifier on GitHub; non-numeric
		// values mean the URI is malformed.
		expect(parsePrFileUri("pi://pr/owner/repo/abc/file/sha/foo.ts")).toBeNull();
	});

	it("returns null when required segments are missing", () => {
		// A truncated URI must not parse into a half-formed shape.
		expect(parsePrFileUri("pi://pr/owner/repo/1/file/sha/")).toBeNull();
		expect(parsePrFileUri("pi://pr/owner/repo/1/file")).toBeNull();
		expect(parsePrFileUri("pi://pr/owner/repo/1")).toBeNull();
	});
});

describe("prFileUri", () => {
	it("constructs a URI matching the parser's expected shape", () => {
		// Construction and parsing must round-trip so the agent
		// can build URIs from state and trust that the resolver
		// will accept them.
		const uri = prFileUri({
			owner: "Jitsusama",
			repo: "agentic-harness.pi",
			number: 180,
			sha: "abc1234",
			path: "src/foo.ts",
		});
		expect(uri).toBe(
			"pi://pr/Jitsusama/agentic-harness.pi/180/file/abc1234/src/foo.ts",
		);
		const parsed = parsePrFileUri(uri);
		expect(parsed?.path).toBe("src/foo.ts");
	});

	it("encodes spaces and other special chars in the path", () => {
		// Round-trip must survive paths with characters that
		// would break URI parsing if left raw.
		const uri = prFileUri({
			owner: "o",
			repo: "r",
			number: 1,
			sha: "s",
			path: "path with space.md",
		});
		expect(uri).toContain("path%20with%20space.md");
		expect(parsePrFileUri(uri)?.path).toBe("path with space.md");
	});
});

describe("resolvePrFile", () => {
	it("fetches content via the injected fetcher and splits into lines", () => {
		// Nvim consumes the buffer as a string array, one entry
		// per line. The resolver fetches once and splits on \n.
		const fetched: Array<{
			owner: string;
			repo: string;
			ref: string;
			path: string;
		}> = [];
		const fetcher = (
			owner: string,
			repo: string,
			ref: string,
			path: string,
		) => {
			fetched.push({ owner, repo, ref, path });
			return Promise.resolve("line one\nline two\nline three");
		};
		return resolvePrFile(
			{
				scheme: "pr-file",
				owner: "o",
				repo: "r",
				number: 1,
				sha: "abc1234",
				path: "src/foo.ts",
			},
			fetcher,
		).then((buffer) => {
			expect(fetched).toEqual([
				{ owner: "o", repo: "r", ref: "abc1234", path: "src/foo.ts" },
			]);
			expect(buffer.lines).toEqual(["line one", "line two", "line three"]);
			expect(buffer.filetype).toBe("typescript");
		});
	});

	it("returns an error buffer when the fetch fails", () => {
		// A failed fetch should not throw out of the resolver;
		// it should produce a buffer with a clear explanation so
		// the user sees what happened in nvim.
		const fetcher = () => Promise.reject(new Error("boom"));
		return resolvePrFile(
			{
				scheme: "pr-file",
				owner: "o",
				repo: "r",
				number: 1,
				sha: "s",
				path: "src/foo.ts",
			},
			fetcher,
		).then((buffer) => {
			expect(buffer.lines.some((l) => l.includes("boom"))).toBe(true);
			expect(buffer.filetype).toBeUndefined();
		});
	});
});

describe("inferFiletype", () => {
	it.each([
		["foo.ts", "typescript"],
		["foo.tsx", "typescriptreact"],
		["foo.js", "javascript"],
		["foo.py", "python"],
		["foo.rb", "ruby"],
		["foo.go", "go"],
		["foo.md", "markdown"],
		["foo.lua", "lua"],
		["src/nested/foo.json", "json"],
		["UPPER.YAML", "yaml"],
	])("maps %s to %s", (path, expected) => {
		// Filetype lets nvim pick syntax highlighting. We map
		// common extensions; case-insensitive.
		expect(inferFiletype(path)).toBe(expected);
	});

	it("returns undefined for unknown or missing extensions", () => {
		// If we don't recognize the extension, leave filetype
		// unset so nvim's own detection runs.
		expect(inferFiletype("README")).toBeUndefined();
		expect(inferFiletype("path.weirdext")).toBeUndefined();
	});
});
