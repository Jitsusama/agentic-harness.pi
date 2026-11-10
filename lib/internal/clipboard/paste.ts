/**
 * What Ctrl+V puts in the editor under Wayland, read the way pi's own
 * paste reads it: copied files as their paths, then an image as a
 * file the editor names, then text. Only the reading differs: it goes
 * through whatever `Read` is given, so the session need not fork.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Read } from "./helper.ts";

/** What the clipboard held, as a paste uses it. */
export type Pasted =
	| { readonly kind: "files"; readonly paths: readonly string[] }
	| {
			readonly kind: "image";
			readonly bytes: Buffer;
			readonly mimeType: string;
	  }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "nothing" };

/** pi's own limits, in milliseconds, for each read. */
const LIST_MS = 1_000;
const IMAGE_MS = 3_000;
const TEXT_MS = 5_000;

/** The image types pi attaches as they are, in the order it prefers. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

/**
 * Whether pi's paste here reads with `wl-paste`: Linux under a Wayland
 * display, and not Termux, which pi reads another way.
 */
export function pastesThroughWayland(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): boolean {
	return (
		platform === "linux" &&
		Boolean(env.WAYLAND_DISPLAY) &&
		env.TERMUX_VERSION === undefined
	);
}

/**
 * Reads the clipboard for a paste. An image pi would convert first (a
 * BMP, say) is passed over for the text beside it, if any.
 */
export async function readPaste(read: Read): Promise<Pasted> {
	const listed = await read(["wl-paste", "--list-types"], LIST_MS);
	const types = (listed?.toString("utf8") ?? "")
		.split(/\r?\n/)
		.map((type) => type.trim())
		.filter(Boolean);

	if (types.includes("text/uri-list")) {
		const uris = await read(["wl-paste", "--type", "text/uri-list"], LIST_MS);
		const paths = filePaths(uris?.toString("utf8") ?? "");
		if (paths.length > 0) return { kind: "files", paths };
	}

	const image = preferredImage(types);
	if (image) {
		const bytes = await read(
			["wl-paste", "--type", image.raw, "--no-newline"],
			IMAGE_MS,
		);
		if (bytes && bytes.length > 0) {
			return { kind: "image", bytes, mimeType: image.base };
		}
	}

	const text = await read(
		["wl-paste", "--no-newline", "--type", "text"],
		TEXT_MS,
	);
	const said = text?.toString("utf8") ?? "";
	return said ? { kind: "text", text: said } : { kind: "nothing" };
}

/** The paths a URI list names, when every entry is a local file. */
function filePaths(list: string): string[] {
	const entries = list
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	if (!entries.every((entry) => entry.startsWith("file://"))) return [];
	try {
		return entries.map((entry) => fileURLToPath(entry));
	} catch {
		// A file URI naming another host isn't a path here, so it isn't a file paste.
		return [];
	}
}

function preferredImage(
	types: readonly string[],
): { raw: string; base: string } | undefined {
	const based = types.map((raw) => ({
		raw,
		base: raw.split(";")[0]?.trim().toLowerCase() ?? "",
	}));
	for (const wanted of IMAGE_TYPES) {
		const found = based.find((type) => type.base === wanted);
		if (found) return found;
	}
	return undefined;
}

/** The parts of pi's editor a paste writes through. */
export interface PasteTarget {
	getText(): string;
	getCursor?(): { line: number; col: number };
	insertTextAtCursor?(text: string): void;
}

/**
 * Puts a paste in the editor as pi's own paste does: paths spaced from
 * the words beside them (quoted in a `!` command), an image as the
 * temporary file it is written to, text as it is.
 */
export async function insertPasted(
	target: PasteTarget,
	pasted: Pasted,
): Promise<void> {
	switch (pasted.kind) {
		case "files": {
			if (pasted.paths.some((path) => /\p{Cc}/u.test(path))) {
				throw new Error("Clipboard file path contains control characters");
			}
			const command = target.getText().trimStart().startsWith("!");
			const paths = command
				? pasted.paths.map(quoteIfNeeded).join(" ")
				: pasted.paths.join("\n");
			const cursor = target.getCursor?.();
			const line = cursor
				? (target.getText().split("\n")[cursor.line] ?? "")
				: "";
			const before = cursor && cursor.col > 0 ? line[cursor.col - 1] : "";
			const after = cursor ? line[cursor.col] : "";
			const lead = before && !/\s/.test(before) ? " " : "";
			const trail = after && !/\s/.test(after) ? " " : "";
			target.insertTextAtCursor?.(`${lead}${paths}${trail}`);
			return;
		}
		case "image": {
			const extension = EXTENSIONS[pasted.mimeType] ?? "png";
			const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
			await writeFile(path, pasted.bytes);
			target.insertTextAtCursor?.(path);
			return;
		}
		case "text":
			target.insertTextAtCursor?.(pasted.text);
			return;
		case "nothing":
			return;
	}
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
