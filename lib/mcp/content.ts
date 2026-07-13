import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpContent, McpToolResult } from "./types.js";

/** A resource that was written to disk. */
export interface SavedResource {
	filePath: string;
	bytes: number;
	mimeType?: string;
	uri?: string;
}

/** A resource that could not be written, with the reason. */
export interface FailedResource {
	filename: string;
	error: string;
	mimeType?: string;
	uri?: string;
}

/** A default ceiling on an inline image, above which it is dropped rather than fed to the model. */
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILENAME_LENGTH = 180;

/** Concatenate the text blocks of a result, ignoring non-text content. */
export function joinTextContent(result: McpToolResult): string {
	return result.content
		.filter(
			(part): part is Extract<McpContent, { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("\n");
}

/**
 * The image blocks of a result, dropping any whose decoded size exceeds the
 * cap so an oversized payload never reaches the model.
 */
export function imageContent(
	result: McpToolResult,
	opts: { maxBytes?: number } = {},
): Array<{ type: "image"; data: string; mimeType: string }> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
	return result.content
		.filter(
			(part): part is Extract<McpContent, { type: "image" }> =>
				part.type === "image",
		)
		.filter((part) => Buffer.byteLength(part.data, "base64") <= maxBytes)
		.map((part) => ({
			type: "image",
			data: part.data,
			mimeType: part.mimeType,
		}));
}

/**
 * Trim text to the first `maxLines` lines or `maxBytes` bytes, whichever hits
 * first, and report how much was shown against the total. The caller owns any
 * truncation marker; this stays a pure transform.
 */
export function truncateForDisplay(
	text: string,
	limits: { maxLines: number; maxBytes: number },
): {
	text: string;
	truncated: boolean;
	shownLines: number;
	totalLines: number;
} {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(text, "utf-8");

	if (totalLines <= limits.maxLines && totalBytes <= limits.maxBytes) {
		return { text, truncated: false, shownLines: totalLines, totalLines };
	}

	let byteCount = 0;
	let shownLines = 0;
	for (let i = 0; i < lines.length && shownLines < limits.maxLines; i++) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + 1;
		if (byteCount + lineBytes > limits.maxBytes && shownLines > 0) break;
		byteCount += lineBytes;
		shownLines++;
	}

	return {
		text: lines.slice(0, shownLines).join("\n"),
		truncated: true,
		shownLines,
		totalLines,
	};
}

/**
 * Write the resource blocks of a result to `dir`, returning what was saved and
 * what failed. Filenames are basenamed and confined to `dir` so a crafted name
 * cannot escape it, and each path is allocated atomically so concurrent calls
 * never race onto the same file.
 */
export function materializeResources(
	result: McpToolResult,
	dir: string,
): { saved: SavedResource[]; failures: FailedResource[] } {
	const saved: SavedResource[] = [];
	const failures: FailedResource[] = [];
	const realDir = ensureDir(dir);

	const resources = result.content.filter(
		(part): part is Extract<McpContent, { type: "resource" }> =>
			part.type === "resource",
	);

	resources.forEach((part, index) => {
		const resource = part.resource;
		const blob = typeof resource.blob === "string" ? resource.blob : undefined;
		const text = typeof resource.text === "string" ? resource.text : undefined;
		if (blob === undefined && text === undefined) return;

		const bytes =
			blob !== undefined
				? Buffer.from(blob, "base64")
				: Buffer.from(text ?? "", "utf8");
		const filename = resourceFilename(result, resource, index);
		const mimeType =
			stringOr(resource.mimeType) ?? stringOr(resource.mime_type);
		const uri = stringOr(resource.uri);

		try {
			const filePath = writeUnique(realDir, filename, bytes);
			saved.push({ filePath, bytes: bytes.length, mimeType, uri });
		} catch (err) {
			failures.push({
				filename,
				error: err instanceof Error ? err.message : String(err),
				mimeType,
				uri,
			});
		}
	});

	return { saved, failures };
}

/** Write the full text to a fresh file in `dir` and return its path, for display overflow the model can open on request. */
export function spillToFile(text: string, dir: string): string {
	const realDir = ensureDir(dir);
	const filename = `spill-${crypto.randomBytes(8).toString("hex")}.txt`;
	return writeUnique(realDir, filename, Buffer.from(text, "utf8"));
}

function ensureDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	return fs.realpathSync(dir);
}

/**
 * Allocate a path under `realDir` for `filename`, suffixing on collision, and
 * write `bytes` to it exclusively (`O_EXCL`) so the check and the create are a
 * single atomic step rather than a race.
 */
function writeUnique(realDir: string, filename: string, bytes: Buffer): string {
	const [stem, ext] = splitExtension(filename);
	for (let attempt = 1; ; attempt++) {
		const candidate = path.join(
			realDir,
			attempt === 1 ? filename : `${stem}-${attempt}${ext}`,
		);
		if (path.dirname(path.resolve(candidate)) !== realDir) {
			throw new Error(`refusing to write outside ${realDir}`);
		}
		try {
			const fd = fs.openSync(
				candidate,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
				FILE_MODE,
			);
			try {
				fs.writeFileSync(fd, bytes);
			} finally {
				fs.closeSync(fd);
			}
			return candidate;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
	}
}

function resourceFilename(
	result: McpToolResult,
	resource: Record<string, unknown>,
	index: number,
): string {
	const structured =
		index === 0 && isRecord(result.structuredContent)
			? stringOr(result.structuredContent.filename)
			: undefined;
	if (structured) return safeFilename(structured);

	const uri = stringOr(resource.uri);
	const ext = extensionForMimeType(
		stringOr(resource.mimeType) ?? stringOr(resource.mime_type),
	);
	if (uri) {
		try {
			const base = safeFilename(
				new URL(uri).pathname.split("/").filter(Boolean).pop() ?? "",
			);
			return /\.[A-Za-z0-9][\w.-]*$/.test(base) ? base : `${base}${ext}`;
		} catch {
			// Not a parseable URL; fall through to the generic name.
		}
	}
	return safeFilename(`resource-${index + 1}${ext}`);
}

/** Reduce an arbitrary name to a single safe path segment: basename only, control and separator characters stripped. */
function safeFilename(input: string, fallback = "mcp-resource.bin"): string {
	const cleaned = path
		.basename(input)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
		.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+$/, "");
	return (cleaned || fallback).slice(0, MAX_FILENAME_LENGTH);
}

function splitExtension(filename: string): [string, string] {
	const lower = filename.toLowerCase();
	for (const ext of [".pprof.pb.gz", ".pb.gz", ".tar.gz"]) {
		if (lower.endsWith(ext))
			return [filename.slice(0, -ext.length), filename.slice(-ext.length)];
	}
	const ext = path.extname(filename);
	return ext ? [filename.slice(0, -ext.length), ext] : [filename, ""];
}

function extensionForMimeType(mimeType: string | undefined): string {
	switch (mimeType?.toLowerCase().split(";")[0].trim()) {
		case "application/gzip":
		case "application/x-gzip":
			return ".gz";
		case "application/json":
			return ".json";
		case "image/png":
			return ".png";
		case "image/jpeg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "text/plain":
			return ".txt";
		default:
			return ".bin";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
