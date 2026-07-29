import { describe, expect, it } from "vitest";
import { createGitHubProvider, githubChange } from "../../../lib/review";
import { fakeExec } from "./support/fake-exec";

const ref = githubChange({ key: "github:o/r" }, "7");

function provider(answer: string, code = 0) {
	const { exec, calls } = fakeExec([{ when: ["api"], stdout: answer, code }]);
	return { provider: createGitHubProvider({ exec }), calls };
}

/** What the contents route returns, base64 as it really is. */
function contents(text: string) {
	return JSON.stringify({
		type: "file",
		encoding: "base64",
		content: Buffer.from(text, "utf8").toString("base64"),
	});
}

describe("reading a file at a commit", () => {
	it("hands back the decoded file", async () => {
		const { provider: gh } = provider(contents("package main\n"));

		const text = await gh.proposals?.fileAt?.(ref, "main.go", "abc123");

		expect(text).toBe("package main\n");
	});

	it("asks for the path at the commit it was given", async () => {
		const { provider: gh, calls } = provider(contents("x"));

		await gh.proposals?.fileAt?.(ref, "cmd/replica.go", "deadbeef");

		const asked = calls.map((c) => c.args.join(" ")).join(" ");
		expect(asked).toContain("repos/o/r/contents/cmd/replica.go");
		expect(asked).toContain("deadbeef");
	});

	it("copes with the newlines the encoding arrives wrapped in", async () => {
		// The route wraps base64 at column 60, so the payload has
		// newlines inside the encoded text that are not part of it.
		const raw = Buffer.from("a".repeat(200), "utf8").toString("base64");
		const wrapped = raw.replace(/(.{60})/g, "$1\n");
		const { provider: gh } = provider(
			JSON.stringify({ encoding: "base64", content: wrapped }),
		);

		expect(await gh.proposals?.fileAt?.(ref, "f", "c")).toBe("a".repeat(200));
	});

	it("says which file and commit it could not read", async () => {
		// A path that does not exist at that commit is the common
		// failure, and the message has to name both to be actionable.
		const { provider: gh } = provider("", 1);

		await expect(
			gh.proposals?.fileAt?.(ref, "gone.go", "abc123"),
		).rejects.toThrow(/gone\.go.*abc123|abc123.*gone\.go/s);
	});

	it("refuses an answer that carries no content", async () => {
		// A directory answers with an array rather than a file, and
		// returning an empty string would look like an empty file.
		const { provider: gh } = provider(JSON.stringify([{ name: "a.go" }]));

		await expect(gh.proposals?.fileAt?.(ref, "cmd", "abc")).rejects.toThrow(
			/no content|not a file/i,
		);
	});
});
