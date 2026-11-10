/**
 * What Ctrl+V reads and puts in the editor under Wayland, in pi's own
 * order: copied files, then an image, then text.
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { Read } from "../../../../lib/internal/clipboard/helper.ts";
import {
	insertPasted,
	type PasteTarget,
	pastesThroughWayland,
	readPaste,
} from "../../../../lib/internal/clipboard/paste.ts";

/** A clipboard holding `held`, by the wl-paste arguments that read each part. */
function clipboard(held: Record<string, string | Buffer | undefined>): {
	read: Read;
	asked: string[];
} {
	const asked: string[] = [];
	const read: Read = async (argv) => {
		const key = argv.slice(1).join(" ");
		asked.push(key);
		const part = held[key];
		return typeof part === "string" ? Buffer.from(part) : part;
	};
	return { read, asked };
}

const TEXT = "--no-newline --type text";
const TYPES = "--list-types";

describe("reading a paste", () => {
	it("reads text when no file or image is offered", async () => {
		const { read, asked } = clipboard({
			[TYPES]: "text/plain\nUTF8_STRING\n",
			[TEXT]: "some words",
		});
		expect(await readPaste(read)).toEqual({ kind: "text", text: "some words" });
		expect(asked).toEqual([TYPES, TEXT]);
	});

	it("prefers an image pi attaches as it is over the text beside it", async () => {
		const bytes = Buffer.from([137, 80, 78, 71]);
		const { read } = clipboard({
			[TYPES]: "text/html\nimage/bmp\nimage/png\n",
			"--type image/png --no-newline": bytes,
			[TEXT]: "alt text",
		});
		expect(await readPaste(read)).toEqual({
			kind: "image",
			bytes,
			mimeType: "image/png",
		});
	});

	it("passes over an image pi would have to convert, for the text", async () => {
		const { read } = clipboard({
			[TYPES]: "image/bmp\ntext/plain\n",
			[TEXT]: "beside it",
		});
		expect(await readPaste(read)).toEqual({ kind: "text", text: "beside it" });
	});

	it("names copied files by their paths", async () => {
		const { read } = clipboard({
			[TYPES]: "text/uri-list\ntext/plain\n",
			"--type text/uri-list":
				"# copied\nfile:///home/me/a%20b.txt\r\nfile:///tmp/c\n",
		});
		expect(await readPaste(read)).toEqual({
			kind: "files",
			paths: ["/home/me/a b.txt", "/tmp/c"],
		});
	});

	it("reads links that aren't local files as text", async () => {
		const { read } = clipboard({
			[TYPES]: "text/uri-list\ntext/plain\n",
			"--type text/uri-list": "https://example.com/\n",
			[TEXT]: "https://example.com/",
		});
		expect(await readPaste(read)).toEqual({
			kind: "text",
			text: "https://example.com/",
		});
	});

	it("still reads text when the types couldn't be listed", async () => {
		const { read } = clipboard({ [TEXT]: "listed nothing" });
		expect(await readPaste(read)).toEqual({
			kind: "text",
			text: "listed nothing",
		});
	});

	it("says nothing was there for an empty clipboard", async () => {
		const { read } = clipboard({ [TYPES]: "", [TEXT]: "" });
		expect(await readPaste(read)).toEqual({ kind: "nothing" });
	});
});

/** An editor holding one line, with its cursor at `col`. */
function editor(
	line: string,
	col: number,
): PasteTarget & { inserted: string[] } {
	const inserted: string[] = [];
	return {
		inserted,
		getText: () => line,
		getCursor: () => ({ line: 0, col }),
		insertTextAtCursor: (text: string) => inserted.push(text),
	};
}

describe("putting a paste in the editor", () => {
	it("puts text in as it is", async () => {
		const target = editor("say ", 4);
		await insertPasted(target, { kind: "text", text: "hello\nthere" });
		expect(target.inserted).toEqual(["hello\nthere"]);
	});

	it("spaces paths from the words they land between", async () => {
		const target = editor("seeit", 3);
		await insertPasted(target, { kind: "files", paths: ["/a", "/b"] });
		expect(target.inserted).toEqual([" /a\n/b "]);
	});

	it("quotes paths that need it in a ! command", async () => {
		const target = editor("!ls ", 4);
		await insertPasted(target, {
			kind: "files",
			paths: ["/plain/path", "/it's here"],
		});
		expect(target.inserted).toEqual([`/plain/path '/it'\\''s here'`]);
	});

	it("refuses a path holding control characters", async () => {
		const target = editor("", 0);
		await expect(
			insertPasted(target, { kind: "files", paths: ["/a\u001b[2J"] }),
		).rejects.toThrow("control characters");
		expect(target.inserted).toEqual([]);
	});

	it("writes an image to a temporary file and names it", async () => {
		const target = editor("", 0);
		const bytes = Buffer.from([255, 216, 255]);
		await insertPasted(target, {
			kind: "image",
			bytes,
			mimeType: "image/jpeg",
		});
		const [path = ""] = target.inserted;
		try {
			expect({
				folder: dirname(path),
				ending: path.slice(-4),
				bytes: [...readFileSync(path)],
			}).toEqual({
				folder: tmpdir(),
				ending: ".jpg",
				bytes: [255, 216, 255],
			});
		} finally {
			rmSync(path, { force: true });
		}
	});
});

describe("where a paste reads through wl-paste", () => {
	it("is Linux under a Wayland display, Termux aside", () => {
		expect([
			pastesThroughWayland("linux", { WAYLAND_DISPLAY: "wayland-1" }),
			pastesThroughWayland("linux", {}),
			pastesThroughWayland("darwin", { WAYLAND_DISPLAY: "wayland-1" }),
			pastesThroughWayland("linux", {
				WAYLAND_DISPLAY: "wayland-1",
				TERMUX_VERSION: "0.118",
			}),
		]).toEqual([true, false, false, false]);
	});
});
