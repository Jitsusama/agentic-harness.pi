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

const mark = (kind: string) => `[secret ${"scrubbed"}: ${kind}]`;

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
});

describe("the marks an edit adds to the file it edits", () => {
	it("are those its new texts hold that its old texts don't", () => {
		const env = mark("environment value");
		const edits = [
			{ oldText: "TOKEN=a1b2c3", newText: `TOKEN=${env}` },
			{ oldText: "PORT=80", newText: "PORT=8080" },
		];
		expect(marksEditAdds(edits)).toEqual([env]);
	});

	it("are none when a mark its old text holds is kept", () => {
		const env = mark("environment value");
		const edits = [{ oldText: `A=${env}\nB=1`, newText: `A=${env}\nB=2` }];
		expect(marksEditAdds(edits)).toEqual([]);
	});

	it("are none when a mark moves from one replacement to another", () => {
		const env = mark("environment value");
		const edits = [
			{ oldText: `A=${env}`, newText: "A=" },
			{ oldText: "B=", newText: `B=${env}` },
		];
		expect(marksEditAdds(edits)).toEqual([]);
	});
});

describe("why a write holding a mark is refused", () => {
	it("names the mark and the credential it would replace", () => {
		const env = mark("environment value");
		const reason = markRefusal([env]);
		expect(reason).toContain(env);
		expect(reason).toContain("credential");
		expect(reason).toContain("edit around it");
	});
});
