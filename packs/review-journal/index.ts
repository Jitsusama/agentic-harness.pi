/**
 * A reviewer writes down a finding the moment it has one.
 *
 * Attached to each reviewer subagent with `--extension`, never
 * auto-discovered, which is why this lives outside `extensions/`: pi
 * scans that directory, and a pack loaded into every session would put
 * this tool in front of the user.
 *
 * The problem it removes is the whole reason the surrounding work
 * exists. A reviewer investigates for ten minutes and says everything
 * it found in one message at the end, so anything that interrupts it
 * costs the entire review. The answer is kept now, whole entries are
 * salvaged from a cut-off one, and a stopped reviewer is asked for what
 * it had; all of that is recovery, and recovery only works if the
 * answer arrives at all. A finding written down when it was found needs
 * no recovering.
 *
 * One JSON object per line, appended, so a reviewer killed mid-write
 * loses the line it was on and nothing above it. The tool does not
 * validate the shape beyond it being a finding at all: the round reads
 * these the same way it reads an answer, warns about what it cannot
 * use, and a reviewer told off by a tool for a missing field would
 * spend its remaining budget arguing with the tool. It reads a batch
 * and a serialized string for the same reason. See `findingsIn`, which
 * is where that bargain either holds or quietly stops holding.
 */

import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** A tool answer, in the shape pi expects. */
function said(text: string) {
	return { content: [{ type: "text" as const, text }], details: { ok: true } };
}

/**
 * Append, answering with what to say when it could not be done.
 *
 * A full disk or a directory swept out from under the run would
 * otherwise throw out of the tool and end the reviewer's turn over
 * housekeeping, which costs the review to protect the record of it.
 * The reviewer is told to keep the finding instead.
 */
async function write(path: string, line: string): Promise<string | undefined> {
	try {
		// One line, one write, appended, so a reviewer killed partway
		// through loses the line it was on and nothing above it. Two
		// cannot interleave: append mode is atomic for writes this size,
		// and a reviewer makes one tool call at a time anyway.
		await appendFile(path, line, "utf8");
		return undefined;
	} catch (error) {
		return (
			"That could not be written down " +
			`(${error instanceof Error ? error.message : String(error)}), ` +
			"so keep it for your final answer and carry on reviewing."
		);
	}
}

/**
 * The findings in whatever the reviewer sent, and how many of
 * the things it sent were not findings.
 *
 * Three encodings are accepted for one reason: the reviewer's
 * intent is not in doubt in any of them, and this tool refusing a
 * finding it can plainly read is how a reviewer ends up recording
 * nothing at all. That is not hypothetical. A real one sent its
 * findings as JSON text, was told six times that a finding has to
 * be an object, and gave up, so the run that was meant to prove
 * the journal works recorded not one line.
 *
 * An array because a reviewer economising on turns under a
 * deadline batches, and text because a model asked for an object
 * will sometimes serialize it first. What stays refused is a
 * sentence, which is not a finding in any encoding.
 */
function findingsIn(sent: unknown): {
	kept: object[];
	dropped: number;
} {
	if (typeof sent === "string") {
		try {
			return findingsIn(JSON.parse(sent));
		} catch {
			// Prose, not a finding. Refused below by having kept nothing.
			return { kept: [], dropped: 1 };
		}
	}
	const each = Array.isArray(sent) ? sent : [sent];
	const kept = each.filter(
		(one): one is object =>
			one !== null && typeof one === "object" && !Array.isArray(one),
	);
	return { kept, dropped: each.length - kept.length };
}

/** Where the supervisor told us to write. Absent outside a round. */
function journalPath(): string | undefined {
	const path = process.env.SUBAGENT_JOURNAL_PATH;
	return path === undefined || path.trim() === "" ? undefined : path;
}

export default function reviewJournal(pi: ExtensionAPI) {
	pi.registerTool({
		name: "record_finding",
		label: "Record finding",
		description:
			"Write down one finding, now, in the shape your output contract " +
			"describes. Call this the moment you are sure of a finding rather " +
			"than saving it for your final answer: what you record is kept even " +
			"if you are interrupted before you can answer. Still include " +
			"everything in your final answer as well; anything recorded and " +
			"then repeated is counted once.",
		parameters: Type.Object({
			finding: Type.Unknown({
				description:
					"One finding, shaped exactly as one entry of the findings " +
					"array in your output contract. An object, ideally, though " +
					"JSON text holding one is read rather than refused.",
			}),
		}),
		async execute(_id: string, params: { finding?: unknown }) {
			const path = journalPath();
			if (path === undefined) {
				return said(
					"Nothing is collecting findings for this run, so there is " +
						"nowhere to record one. Put it in your final answer instead.",
				);
			}
			const sent = findingsIn(params?.finding);
			if (sent.kept.length === 0) {
				return said(
					"A finding has to be an object shaped like one entry of your " +
						"contract's findings array. Nothing was recorded.",
				);
			}
			const wrote = await write(
				path,
				`${sent.kept.map((one) => JSON.stringify(one)).join("\n")}\n`,
			);
			if (wrote !== undefined) return said(wrote);
			if (sent.dropped > 0) {
				return said(
					`Recorded ${sent.kept.length} of them. The other ${sent.dropped} ` +
						"were not findings and were not recorded, so send those again " +
						"one at a time if they matter.",
				);
			}
			if (sent.kept.length > 1) {
				return said(
					`Recorded ${sent.kept.length} of them, one per line. Record each ` +
						"one as you find it rather than in batches: a batch you are " +
						"still holding when you are stopped is a batch nobody gets. " +
						"Include them in your final answer too.",
				);
			}
			return said("Recorded. Include it in your final answer too.");
		},
	});
}
