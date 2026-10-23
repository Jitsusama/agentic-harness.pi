/**
 * What a stray write was and whose: the line a person can read, and
 * the extension or package that wrote it.
 *
 * The writer is read off stack frames. An error's own stack, inside
 * the text, comes first, because pi's event bus is what writes a
 * throwing handler's error: the call stack names pi, and only the
 * error's frames name the handler. pi's own frames and node's are
 * passed over, since pi is the messenger in every case worth asking
 * about.
 */

import { stripVTControlCharacters } from "node:util";
import type { StrayWrite } from "./guard.ts";

/** A stray write, read for a person. */
export interface StrayReport {
	/** Its first line, as it would have read on the screen. */
	readonly line: string;
	/** The extension or package that wrote it, when a frame names one. */
	readonly writer?: string;
	/** The `pi.events` channel whose handler threw, when it was one. */
	readonly channel?: string;
}

/** How long a line may be before it is cut. */
const LINE_MAX = 160;

/** How pi's event bus opens what it says of a handler that threw. */
const BUS_ERROR = /^Event handler error \(([^)]+)\):\s*/;

/** A frame's path, with or without a `file://` in front. */
const FRAME_PATH = /(?:file:\/\/)?(\/[^\s():]+):\d+:\d+/g;

/** Frames that belong to pi or node rather than to whoever wrote. */
const MESSENGERS = [
	/\/pi-coding-agent[^/]*\//,
	/\/pi-monorepo\//,
	/\/@earendil-works\/pi-/,
];

/** Read a stray write for a person. */
export function reportOf(write: StrayWrite): StrayReport {
	const plain = stripVTControlCharacters(write.text);
	const bus = BUS_ERROR.exec(plain.trimStart());
	const said = bus ? plain.trimStart().slice(bus[0].length) : plain;
	const line = firstLine(said);
	const writer = writerIn(plain) ?? writerIn(write.stack);
	return {
		line,
		...(writer ? { writer } : {}),
		...(bus?.[1] ? { channel: bus[1] } : {}),
	};
}

/** The first frame in some text that names a writer, by its short name. */
function writerIn(text: string): string | undefined {
	for (const match of text.matchAll(FRAME_PATH)) {
		const path = match[1];
		if (!path || MESSENGERS.some((pattern) => pattern.test(path))) continue;
		return nameOf(path);
	}
	return undefined;
}

/** An extension by its directory, a package by its name, else the path. */
function nameOf(path: string): string {
	const extension = /\/(?:extensions|packs)\/([^/]+)\//.exec(path);
	if (extension?.[1]) return extension[1];
	const packages = [
		...path.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//g),
	];
	const named = packages.at(-1)?.[1];
	return named ?? path;
}

/** The first line with anything on it, cut to fit a notice. */
function firstLine(text: string): string {
	const line =
		text
			.split("\n")
			.map((each) => each.trim())
			.find((each) => each.length > 0) ?? "(an empty write)";
	return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 3)}...` : line;
}
