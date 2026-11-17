/**
 * A scrub's mark written back into a file is found, and a mark the file
 * already holds is not, so a write or an edit can be refused only for
 * what would replace a credential.
 *
 * Each mark is made from pieces as the test runs, so this file can be
 * edited however the rule it tests reads.
 */

import { describe, expect, it } from "vitest";
import {
	markRefusal,
	marksAdded,
	marksEditAdds,
} from "../../../../lib/internal/secrets/marks.ts";
import {
	scrubbedMark,
	scrubSecrets,
} from "../../../../lib/internal/secrets/secrets.ts";

const mark = scrubbedMark;

describe("the marks a new text adds to an old one", () => {
	it("are none when the new text holds none", () => {
		expect(marksAdded("API_KEY=a1b2", "API_KEY=c3d4")).toEqual([]);
	});

	it("name a mark the old text doesn't hold", () => {
		const env = mark("environment value");
		expect(marksAdded("TOKEN=a1b2c3\n", `TOKEN=${env}\n`)).toEqual([env]);
	});

	it("are none for a mark the old text already holds", () => {
		const aws = mark("AWS access key");
		const test = `const MARK = "${aws}";\n`;
		expect(marksAdded(test, `${test}expect(text).toBe(MARK);\n`)).toEqual([]);
	});

	it("name a mark the new text holds more of than the old", () => {
		const env = mark("environment value");
		expect(marksAdded(`A=${env}\n`, `A=${env}\nB=${env}\n`)).toEqual([env]);
	});

	it("name each mark once, in the order the new text first holds them", () => {
		const github = mark("GitHub token");
		const env = mark("environment value");
		const after = `${env} ${github} ${env} ${github}`;
		expect(marksAdded("", after)).toEqual([env, github]);
	});

	it("leave out words a line ends before they close", () => {
		expect(marksAdded("", `[secret ${"scrubbed"}: half\n]`)).toEqual([]);
	});

	it("name every mark the scrub puts where a credential was", () => {
		const github = `ghp_${"a1B2".repeat(9)}`;
		const aws = `AK${"IA"}${"QQQQWWWWEEEERRRR"}`;
		const known = `z9${"c3d4".repeat(8)}`;
		const read = `GH=${github}\nAWS=${aws}\nTOKEN=${known}\n`;
		const { text } = scrubSecrets(read, [{ name: "TOKEN", value: known }]);
		expect(marksAdded(read, text)).toEqual([
			mark("GitHub token"),
			mark("AWS access key"),
			mark("TOKEN"),
		]);
	});

	it("leave out the words code and notes about a mark write for its shape", () => {
		const opening = `[secret ${"scrubbed"}: `;
		for (const about of [
			`/\\${opening}[^\\]\\n]*\\]/g`,
			`\`${opening}\${kind}]\``,
			`${opening}\u2026]`,
		]) {
			expect(marksAdded("", about), about).toEqual([]);
		}
	});
});

describe("the marks an edit adds to the file it edits", () => {
	it("are those its new texts hold that its old texts don't", () => {
		const env = mark("environment value");
		const edits = [
			{ oldText: "TOKEN=a1b2c3", newText: `TOKEN=${env}` },
			{ oldText: "PORT=80", newText: "PORT=8080" },
		];
		expect(marksEditAdds("TOKEN=a1b2c3\nPORT=80\n", edits)).toEqual([env]);
	});

	it("are none when a mark its old text holds is kept", () => {
		const env = mark("environment value");
		const edits = [{ oldText: `A=${env}\nB=1`, newText: `A=${env}\nB=2` }];
		expect(marksEditAdds(`A=${env}\nB=1\n`, edits)).toEqual([]);
	});

	it("are none when a mark moves from one replacement to another", () => {
		const env = mark("environment value");
		const edits = [
			{ oldText: `A=${env}`, newText: "A=" },
			{ oldText: "B=", newText: `B=${env}` },
		];
		expect(marksEditAdds(`A=${env}\nB=\n`, edits)).toEqual([]);
	});

	it("name another copy of a mark the file holds outside the old texts", () => {
		const env = mark("environment value");
		const edits = [{ oldText: "B=1", newText: `B=${env}` }];
		expect(marksEditAdds(`A=${env}\nB=1\n`, edits)).toEqual([env]);
	});

	it("name a mark two replacements beside each other make between them", () => {
		const edits = [
			{ oldText: "A", newText: `[secret ${"scrubbed"}: TOKEN` },
			{ oldText: "B", newText: "]" },
		];
		expect(marksEditAdds("AB\n", edits)).toEqual([mark("TOKEN")]);
	});

	it("name a mark a new text spells in escapes", () => {
		const spelled = "\\u005bsecret scrubbed: environment value\\u005d";
		const edits = [{ oldText: "TOKEN\\u003d", newText: `TOKEN=${spelled}` }];
		expect(marksEditAdds("TOKEN=\n", edits)).toEqual([
			mark("environment value"),
		]);
	});

	it("are read from its texts alone when an old text doesn't match once", () => {
		const env = mark("environment value");
		const edits = [{ oldText: "MISSING", newText: `X=${env}` }];
		expect(marksEditAdds("A=1\n", edits)).toEqual([env]);
	});
});

describe("why a write holding a mark is refused", () => {
	it("names the mark and the credential it would replace", () => {
		const env = mark("environment value");
		const reason = markRefusal([env]);
		expect(reason).toContain(env);
		expect(reason).toContain("credential");
		expect(reason).toContain("edit around it");
		expect(reason).toContain("from pieces");
	});
});
