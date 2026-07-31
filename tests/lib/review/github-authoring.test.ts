import { describe, expect, it } from "vitest";
import type { ChangeRef, RepoLocator } from "../../../lib/review";
import { githubAuthoring } from "../../../lib/review";
import { fakeExec } from "./support/fake-exec.js";

const repo: RepoLocator = { key: "github:o/r" };

const ref: ChangeRef = {
	provider: "github",
	repo,
	id: "7",
	label: "o/r#7",
};

/** What the REST API answers with for a pull request. */
const pull = JSON.stringify({
	number: 7,
	title: "Do the thing",
	body: "because",
	state: "open",
	draft: false,
	user: { login: "wren" },
	base: { ref: "main" },
	head: { ref: "topic", sha: "abc123" },
	html_url: "https://github.com/o/r/pull/7",
});

describe("proposing a change", () => {
	it("sends the base, head, title and body", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls"], stdout: pull }]);

		await githubAuthoring(exec).propose({
			repo,
			base: "main",
			head: "topic",
			title: "Do the thing",
			body: "because",
			draft: false,
		});

		const sent: unknown = JSON.parse(calls[0]?.input ?? "{}");
		expect(sent).toMatchObject({
			base: "main",
			head: "topic",
			title: "Do the thing",
			body: "because",
		});
	});

	it("always says whether it is a draft, even when it is not", async () => {
		// The measured hazard: this backend defaults to ready and another
		// defaults to draft, so an omitted flag means two different
		// things. Sending it always is what makes the same call mean the
		// same thing everywhere.
		const { exec, calls } = fakeExec([{ when: ["pulls"], stdout: pull }]);

		await githubAuthoring(exec).propose({
			repo,
			base: "main",
			head: "topic",
			title: "t",
			body: "b",
			draft: false,
		});

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.draft).toBe(false);
	});

	it("forwards a draft request as a draft", async () => {
		// The other half of the same rule: the flag is passed through as
		// given, never interpreted.
		const { exec, calls } = fakeExec([{ when: ["pulls"], stdout: pull }]);

		await githubAuthoring(exec).propose({
			repo,
			base: "main",
			head: "topic",
			title: "t",
			body: "b",
			draft: true,
		});

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.draft).toBe(true);
	});

	it("posts to the repo's own pulls route", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls"], stdout: pull }]);

		await githubAuthoring(exec).propose({
			repo,
			base: "main",
			head: "topic",
			title: "t",
			body: "b",
			draft: true,
		});

		expect(calls[0]?.args).toContain("repos/o/r/pulls");
		expect(calls[0]?.args).toContain("POST");
	});

	it("returns the change it made, not just an id", async () => {
		// So a caller can go straight on to reviewing it without another
		// round trip to learn what it just created.
		const { exec } = fakeExec([{ when: ["pulls"], stdout: pull }]);

		const made = await githubAuthoring(exec).propose({
			repo,
			base: "main",
			head: "topic",
			title: "Do the thing",
			body: "because",
			draft: false,
		});

		expect(made.ref.id).toBe("7");
		expect(made.title).toBe("Do the thing");
		expect(made.head).toBe("topic");
	});
});

describe("editing a change", () => {
	it("sends only the fields being set", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls/7"], stdout: pull }]);

		await githubAuthoring(exec).edit(ref, {
			title: { action: "set", value: "Better title" },
		});

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent).toEqual({ title: "Better title" });
	});

	it("clears a field by sending it empty", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls/7"], stdout: pull }]);

		await githubAuthoring(exec).edit(ref, { body: { action: "clear" } });

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent).toEqual({ body: "" });
	});

	it("retargets by setting the base", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls/7"], stdout: pull }]);

		await githubAuthoring(exec).edit(ref, {
			base: { action: "set", value: "release" },
		});

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.base).toBe("release");
	});

	it("refuses to clear the base, since a change must target something", async () => {
		const { exec } = fakeExec([{ when: ["pulls/7"], stdout: pull }]);

		await expect(
			githubAuthoring(exec).edit(ref, { base: { action: "clear" } }),
		).rejects.toThrow(/base/i);
	});
});

describe("closing, reopening and drafting", () => {
	it("closes by setting the state", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls/7"], stdout: pull }]);

		await githubAuthoring(exec).close(ref);

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.state).toBe("closed");
	});

	it("says why when closing with a comment", async () => {
		// A close with no reason reads as abandonment. The comment goes
		// first, so a close that fails still leaves the reason behind
		// rather than a silently shut change.
		const { exec, calls } = fakeExec([
			{ when: ["issues/7/comments"], stdout: "{}" },
			{ when: ["pulls/7"], stdout: pull },
		]);

		await githubAuthoring(exec).close(ref, "superseded by #9");

		expect(calls[0]?.args.join(" ")).toContain("issues/7/comments");
		expect(calls[1]?.args.join(" ")).toContain("pulls/7");
	});

	it("reopens by setting the state back", async () => {
		const { exec, calls } = fakeExec([{ when: ["pulls/7"], stdout: pull }]);

		await githubAuthoring(exec).reopen?.(ref);

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.state).toBe("open");
	});

	it("moves a change to ready through its own route", async () => {
		// Not a field on the pull request: GitHub only flips this through
		// GraphQL, which is why setDraft is not part of edit. GraphQL wants
		// a node id, which REST does not carry, so it costs a lookup first.
		const { exec, calls } = fakeExec([
			{ when: ["--jq", ".node_id"], stdout: "PR_abc\n" },
			{ when: ["graphql"], stdout: "{}" },
		]);

		await githubAuthoring(exec).setDraft?.(ref, false);

		expect(calls[1]?.args.join(" ")).toMatch(/markPullRequestReadyForReview/);
	});

	it("sends the node id GraphQL needs, trimmed", async () => {
		// The lookup answers with a trailing newline, and a node id with a
		// newline in it is not a node id.
		const { exec, calls } = fakeExec([
			{ when: ["--jq", ".node_id"], stdout: "PR_abc\n" },
			{ when: ["graphql"], stdout: "{}" },
		]);

		await githubAuthoring(exec).setDraft?.(ref, true);

		expect(calls[1]?.args).toContain("id=PR_abc");
	});

	it("returns a ready change to draft through the other mutation", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["--jq", ".node_id"], stdout: "PR_abc\n" },
			{ when: ["graphql"], stdout: "{}" },
		]);

		await githubAuthoring(exec).setDraft?.(ref, true);

		expect(calls[1]?.args.join(" ")).toMatch(/convertPullRequestToDraft/);
	});
});

describe("merging", () => {
	it("reports that it merged, and the commit it produced", async () => {
		// GitHub's merge endpoint lands the change then and there, so it can
		// say so. The point of the outcome is the backends that cannot: a
		// caller told `merged` will go and prune the branch.
		const { exec } = fakeExec([
			{ when: ["merge"], stdout: '{"merged":true,"sha":"f00dcafe1234"}' },
		]);

		const outcome = await githubAuthoring(exec).merge(ref, {});

		expect(outcome.kind).toBe("merged");
		expect(outcome.kind === "merged" && outcome.commit).toBe("f00dcafe1234");
	});

	it("reports the merge without a commit when the backend named none", async () => {
		// Absent means unreported, not zero: inventing a commit here would be
		// worse than saying it landed and leaving the sha out.
		const { exec } = fakeExec([{ when: ["merge"], stdout: "{}" }]);

		const outcome = await githubAuthoring(exec).merge(ref, {});

		expect(outcome).toEqual({ kind: "merged" });
	});

	it("guards on the commit it was told to expect", async () => {
		// The only protection against merging work nobody looked at.
		const { exec, calls } = fakeExec([{ when: ["merge"], stdout: "{}" }]);

		await githubAuthoring(exec).merge(ref, { expectedHead: "abc123" });

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.sha).toBe("abc123");
	});

	it("passes the method when one is named", async () => {
		const { exec, calls } = fakeExec([{ when: ["merge"], stdout: "{}" }]);

		await githubAuthoring(exec).merge(ref, { method: "squash" });

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.merge_method).toBe("squash");
	});

	it("sends no method when none is named", async () => {
		// Rather than picking one. Which merge a repo wants is the repo's
		// settled policy, and overriding it silently rewrites history a
		// way the project did not choose.
		const { exec, calls } = fakeExec([{ when: ["merge"], stdout: "{}" }]);

		await githubAuthoring(exec).merge(ref, {});

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent).not.toHaveProperty("merge_method");
	});
});

describe("requesting reviewers", () => {
	it("sends the people asked for", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["requested_reviewers"], stdout: "{}" },
		]);

		await githubAuthoring(exec).requestReviewers?.(ref, ["wren", "finch"]);

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.reviewers).toEqual(["wren", "finch"]);
	});

	it("asks nobody when the list is empty", async () => {
		// An empty request is a request GitHub accepts and does nothing
		// with, and spending a call on it makes a caller think it worked.
		const { exec, calls } = fakeExec([
			{ when: ["requested_reviewers"], stdout: "{}" },
		]);

		await githubAuthoring(exec).requestReviewers?.(ref, []);

		expect(calls).toEqual([]);
	});
});

describe("when the API refuses", () => {
	it("says what GitHub said", async () => {
		const { exec } = fakeExec([
			{ when: ["pulls"], code: 1, stderr: "No commits between main and topic" },
		]);

		await expect(
			githubAuthoring(exec).propose({
				repo,
				base: "main",
				head: "topic",
				title: "t",
				body: "b",
				draft: false,
			}),
		).rejects.toThrow(/No commits between main and topic/);
	});
});
