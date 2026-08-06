/**
 * The tool a reviewer uses to write a finding down as it finds one.
 *
 * A pack rather than an extension, loaded into a reviewer subagent with
 * `--extension`, so nothing here runs in the session that dispatched
 * the round.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import reviewJournal from "../../packs/review-journal/index.js";

type Tool = {
	name: string;
	execute: (id: string, params: unknown) => Promise<unknown>;
};

let dir: string;
let journal: string;
let was: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "journal-pack-"));
	journal = join(dir, "journal.ndjson");
	was = process.env.SUBAGENT_JOURNAL_PATH;
	process.env.SUBAGENT_JOURNAL_PATH = journal;
});

afterEach(async () => {
	if (was === undefined) delete process.env.SUBAGENT_JOURNAL_PATH;
	else process.env.SUBAGENT_JOURNAL_PATH = was;
	await rm(dir, { recursive: true, force: true });
});

/** The tool, as the pack registered it. */
function recordFinding(): Tool {
	let found: Tool | undefined;
	const pi = {
		registerTool(definition: Tool) {
			found = definition;
		},
	};
	reviewJournal(pi as never);
	if (found === undefined) throw new Error("the pack registered no tool");
	return found;
}

/** Every line written so far, parsed. Nothing written is nothing. */
async function written(): Promise<unknown[]> {
	const raw = await readFile(journal, "utf8").catch(
		(error: NodeJS.ErrnoException) =>
			error.code === "ENOENT" ? "" : Promise.reject(error),
	);
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

describe("recording a finding", () => {
	it("writes one line per finding, in the order they were found", async () => {
		// A line each, because a reviewer killed partway through writing
		// loses the line it was on and keeps every one above it. A single
		// growing document would lose the lot.
		const tool = recordFinding();

		await tool.execute("1", { finding: { subject: "the first" } });
		await tool.execute("2", { finding: { subject: "the second" } });

		expect(await written()).toEqual([
			{ subject: "the first" },
			{ subject: "the second" },
		]);
	});

	it("keeps whatever shape the reviewer gave it", async () => {
		// The round reads these the same way it reads an answer, and
		// warns about what it cannot use. A tool that argued about a
		// missing field would spend the reviewer's remaining budget on
		// the argument.
		const tool = recordFinding();

		await tool.execute("1", { finding: { nothing: "like a finding" } });

		expect(await written()).toEqual([{ nothing: "like a finding" }]);
	});

	it("says so rather than throwing when there is nowhere to write", async () => {
		// The pack can be loaded outside a supervised round, where no
		// path is set. Throwing would end a reviewer's turn over
		// housekeeping.
		delete process.env.SUBAGENT_JOURNAL_PATH;
		const tool = recordFinding();

		const answer = (await tool.execute("1", {
			finding: { subject: "nowhere to go" },
		})) as { content: { text: string }[] };

		expect(answer.content[0].text).toMatch(/final answer/i);
	});

	it("reads a finding the reviewer serialized as a string", async () => {
		// What a real reviewer sent, six times, before giving up and
		// recording nothing at all: the finding as JSON text rather than
		// as an object. The intent is not in doubt and only the encoding
		// is wrong, which is the same bargain as unpacking a batch.
		const tool = recordFinding();

		const answer = (await tool.execute("1", {
			finding: JSON.stringify({
				label: "note",
				subject: "sent as text",
				discussion: "...",
			}),
		})) as { content: { text: string }[] };

		expect(await written()).toEqual([
			{ label: "note", subject: "sent as text", discussion: "..." },
		]);
		expect(answer.content[0].text).toMatch(/recorded/i);
	});

	it("reads a batch the reviewer serialized as a string", async () => {
		const tool = recordFinding();

		await tool.execute("1", {
			finding: JSON.stringify([{ subject: "the first" }, { subject: "and" }]),
		});

		expect(await written()).toEqual([
			{ subject: "the first" },
			{ subject: "and" },
		]);
	});

	it("still refuses a sentence, which is not a finding in any encoding", async () => {
		const tool = recordFinding();

		const answer = (await tool.execute("1", {
			finding: "the error path here looks wrong",
		})) as { content: { text: string }[] };

		expect(await written()).toEqual([]);
		expect(answer.content[0].text).toMatch(/nothing was recorded/i);
	});

	it("unpacks a batch rather than swallowing it whole", async () => {
		// An array is an object, so a batch used to sail past the guard,
		// be written as one line, and be answered with "Recorded", while
		// the round dropped every finding in it: the entry reader takes
		// an array for something that is not a finding. The reviewer's
		// instinct is right and only its turn economy is wrong.
		const tool = recordFinding();

		const answer = (await tool.execute("1", {
			finding: [{ subject: "the first" }, { subject: "the second" }],
		})) as { content: { text: string }[] };

		expect(await written()).toEqual([
			{ subject: "the first" },
			{ subject: "the second" },
		]);
		expect(answer.content[0].text).toMatch(/as you find it/i);
	});

	it("says what it dropped out of a batch, not just what it kept", async () => {
		const tool = recordFinding();

		const answer = (await tool.execute("1", {
			finding: [{ subject: "a real one" }, "just a sentence"],
		})) as { content: { text: string }[] };

		expect(await written()).toEqual([{ subject: "a real one" }]);
		expect(answer.content[0].text).toMatch(/other 1 were not findings/i);
	});

	it("tells the reviewer to carry on when the write fails", async () => {
		// Throwing here would end a reviewer's turn over housekeeping,
		// which costs the review to protect the record of it.
		process.env.SUBAGENT_JOURNAL_PATH = join(dir, "no-such-dir", "j.ndjson");
		const tool = recordFinding();

		const answer = (await tool.execute("1", {
			finding: { subject: "nowhere to put this" },
		})) as { content: { text: string }[] };

		expect(answer.content[0].text).toMatch(/final answer|carry on/i);
	});

	it("refuses something that is not a finding without writing it", async () => {
		const tool = recordFinding();

		await tool.execute("1", { finding: "just a sentence" });

		await expect(readFile(journal, "utf8")).rejects.toThrow();
	});
});
