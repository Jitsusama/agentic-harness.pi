/**
 * What a session is called in the mail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { namesFor } from "../../../lib/mail/names.ts";

let root: string;
const session = "01a15f3a-2255-7463-9909-afa624b025fe";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mail-names-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const paths = () => ({
	sessions: join(root, "sessions"),
	quests: join(root, "quests"),
});

function quest(id: string, lists: string) {
	mkdirSync(join(root, "quests", id), { recursive: true });
	writeFileSync(join(root, "quests", id, "README.md"), lists, "utf8");
}

function loaded(questId: string) {
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(
		join(root, "sessions", `${session}.json`),
		JSON.stringify({ quest: questId }),
		"utf8",
	);
}

describe("a session's names", () => {
	it("signs with the quest it has loaded, ahead of older quests", () => {
		// The bug the interim mailbox had: a session listed in two
		// READMEs signed with whichever the folder listed last.
		quest("QEST-20261021-AF7P9P", `- ${session}`);
		quest("QEST-20261021-7M6JKG", `- ${session}`);
		loaded("QEST-20261021-7M6JKG");

		expect(namesFor(session, paths())).toEqual([
			"7M6JKG",
			"AF7P9P",
			"01A15F3A",
		]);
	});

	it("answers to an older quest that lists it, so mail sent there arrives", () => {
		quest("QEST-20261021-AF7P9P", `- ${session}`);
		quest("QEST-20261021-ZZZZZZ", "- someone-else");

		expect(namesFor(session, paths())).toEqual(["AF7P9P", "01A15F3A"]);
	});

	it("is its session id alone with no quest store", () => {
		expect(namesFor(session, paths())).toEqual(["01A15F3A"]);
	});
});
