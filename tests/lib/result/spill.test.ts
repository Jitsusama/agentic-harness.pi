import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spillText } from "../../../lib/result/spill.js";

describe("spillText", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "spill-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("writes the text and returns where it went", () => {
		const written = spillText('{"a":1}', dir);

		expect(fs.readFileSync(written.path, "utf-8")).toBe('{"a":1}');
		expect(written.reused).toBe(false);
	});

	it("creates the directory when it is not there yet", () => {
		const nested = path.join(dir, "deep", "deeper");

		const written = spillText("hello", nested);

		expect(fs.readFileSync(written.path, "utf-8")).toBe("hello");
	});

	it("keeps different payloads apart", () => {
		const first = spillText("first", dir);
		const second = spillText("second", dir);

		expect(second.path).not.toBe(first.path);
		// Both must still resolve: a handle that started pointing at
		// somebody else's bytes would be worse than no store at all.
		expect(fs.readFileSync(first.path, "utf-8")).toBe("first");
		expect(fs.readFileSync(second.path, "utf-8")).toBe("second");
	});

	it("stores an identical payload once", () => {
		// A caller who navigates, reads the page, clicks and reads again
		// produces the same outline repeatedly. Each copy used to cost
		// its own file and its own handle.
		const outline = JSON.stringify({ nodes: [{ role: "button" }] });

		const first = spillText(outline, dir);
		const again = spillText(outline, dir);

		expect(again.path).toBe(first.path);
		expect(again.reused).toBe(true);
		expect(fs.readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(
			1,
		);
	});

	it("keeps a payload to its owner", () => {
		const written = spillText("private", dir);

		const mode = fs.statSync(written.path).mode & 0o777;
		expect(mode & 0o077).toBe(0);
	});

	it("replaces a payload an interrupted write left half-finished", () => {
		const text = JSON.stringify({
			rows: Array.from({ length: 200 }, (_, i) => i),
		});
		const first = spillText(text, dir);

		// What a crash or a full disk leaves behind: the right name, the
		// wrong bytes. The name is derived from the content, so the old
		// code took the name existing as proof the content matched and
		// handed back a handle to a truncated payload, for the rest of
		// the session and for every later answer with the same content.
		fs.writeFileSync(first.path, text.slice(0, 40));

		const second = spillText(text, dir);

		expect(second.path).toBe(first.path);
		expect(fs.readFileSync(second.path, "utf-8")).toBe(text);
	});

	it("leaves nothing behind but the payload itself", () => {
		spillText("written through a temporary name", dir);

		// An atomic write needs somewhere to put the bytes before it
		// commits to the name. Whatever it uses must not survive, or the
		// directory fills with debris the quota counts and the reaper
		// does not recognize.
		expect(fs.readdirSync(dir).every((name) => name.endsWith(".json"))).toBe(
			true,
		);
	});
});
