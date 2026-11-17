/**
 * What the supervisor reads back of what a reviewer wrote beside its
 * stream: the journal of findings it kept as it went, the envelope
 * verify_output wrote, and the session file pi minted.
 *
 * Plain `.mjs`, as the supervisor is, because node runs that script
 * directly and won't strip types under `node_modules`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import {
	JOURNAL_SAYS,
	journalWarnings,
	parseJournal,
	// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
} from "./journal.mjs";
import { errorCode } from "./supervisor-text.mjs";

/**
 * A value parsed from a file a reviewer wrote. Nothing vouches for its
 * shape, so each field is checked where it is read.
 *
 * @typedef {any} Parsed
 */
/** @typedef {import("../subagent.ts").ReviewerVerification} Verification */

/**
 * Find the session file pi minted inside the private session dir. pi
 * names it "<timestamp>_<uuid>.jsonl"; on a resume there may be more
 * than one, so the newest wins. Answers undefined when the reviewer
 * crashed before pi wrote any session, which is how a genuine
 * no-session run stays distinct from a resumable one.
 *
 * @param {string | undefined} dir
 */
export async function discoverSessionPath(dir) {
	if (!dir) return undefined;
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return undefined;
	}
	const sessions = entries.filter((name) => name.endsWith(".jsonl"));
	if (sessions.length === 0) return undefined;
	let newest;
	let newestMtime = -1;
	for (const name of sessions) {
		const full = `${dir}/${name}`;
		try {
			const mtime = (await stat(full)).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = full;
			}
		} catch {
			// Raced deletion; skip.
		}
	}
	return newest;
}

/**
 * What the reviewer wrote down while it worked.
 *
 * One JSON object per line, and a line that will not parse costs that
 * line alone: a reviewer killed mid-write leaves a half-written last
 * line, and everything above it is intact and paid for. Dropping the
 * lot over the line the kill landed on would give up exactly what this
 * file exists to keep.
 *
 * @param {string | undefined} path
 * @param {(message: string) => void} warn
 */
export async function readJournal(path, warn) {
	if (!path) return [];
	let raw;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		// No file is the ordinary case: the reviewer recorded nothing.
		// Anything else is a file we cannot read, which is not the same
		// as an empty one and must not be reported as one.
		if (errorCode(error) !== "ENOENT") {
			warn(
				`${JOURNAL_SAYS} could not read back what this reviewer wrote down (${errorCode(error)}); anything it recorded is still at ${path}`,
			);
		}
		return [];
	}
	const counts = parseJournal(raw);
	for (const said of journalWarnings(counts, path)) warn(said);
	return counts.entries;
}

/**
 * The verification the verify_output tool wrote to its envelope, or
 * undefined when it wrote none or not an ok one.
 *
 * When present it is the source of truth: the payload arrived
 * out-of-band, so it bypassed the stream line cap on the way here and
 * must bypass the assistant-text cap on the way back. A crashed
 * reviewer writes no file, which is how a genuine empty result (an
 * empty findings array on disk) stays distinct from a crash (no file
 * at all). That holds only because supervisor.mjs removes the
 * envelope before it spawns: a retry reuses the path, and an earlier
 * attempt's envelope would read as this one's.
 *
 * @param {string | undefined} path
 * @param {(message: string) => void} warn
 * @returns {Promise<Verification | undefined>}
 */
export async function verifiedEnvelope(path, warn) {
	if (!path) return undefined;
	let raw;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return undefined; // No envelope: fall back to stream-captured verification.
	}
	/** @type {Parsed} */
	let envelope;
	try {
		envelope = JSON.parse(raw);
	} catch {
		warn("Verify-output envelope was not valid JSON; ignored");
		return undefined;
	}
	if (!envelope || typeof envelope !== "object" || envelope.ok !== true)
		return undefined;
	return {
		called: true,
		ok: true,
		outOfBand: true,
		...(typeof envelope.stage === "string" ? { stage: envelope.stage } : {}),
		...(typeof envelope.count === "number" ? { count: envelope.count } : {}),
		...(Array.isArray(envelope.warnings)
			? {
					warnings: envelope.warnings.filter(
						(/** @type {unknown} */ w) => typeof w === "string",
					),
				}
			: {}),
		...("output" in envelope ? { output: envelope.output } : {}),
	};
}
