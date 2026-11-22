import { describe, expect, it } from "vitest";
import type { Exec } from "../../../../../lib/core/exec/index.ts";
import type {
	ChangeRef,
	RepoLocator,
} from "../../../../../lib/core/review/index.ts";
import { githubAuthoring } from "../../../../../lib/core/review/index.ts";
import { callMatching, fakeExec } from "../../../../support/fake-exec.ts";

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
		expect(sent).toMatchObject({ draft: false });
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
		expect(sent).toMatchObject({ draft: true });
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

/**
 * An exec whose creates answer in turn from `creates`, and whose
 * listing of open pull requests answers `open`, recording each call.
 */
function answering(creates: string[], open: string) {
	const calls: string[][] = [];
	const exec: Exec = async (_command, args) => {
		calls.push(args);
		const stdout = args.includes("POST") ? (creates.shift() ?? "") : open;
		return { code: 0, stdout, stderr: "" };
	};
	const posts = () => calls.filter((args) => args.includes("POST")).length;
	return { exec, calls, posts };
}

const topic = {
	repo,
	base: "main",
	head: "topic",
	title: "Do the thing",
	body: "because",
	draft: false,
};

describe("a create that answers with nothing", () => {
	it("takes the open pull request from its head, creating nothing more", async () => {
		const { exec, calls, posts } = answering([""], `[${pull}]`);

		const made = await githubAuthoring(exec).propose(topic);

		expect(made.ref.id).toBe("7");
		expect(posts()).toBe(1);
		expect(calls[1]?.join(" ")).toContain(
			"repos/o/r/pulls?head=o%3Atopic&base=main&state=open",
		);
	});

	it("creates once more when none is open, since nothing was made", async () => {
		const { exec, posts } = answering(["", pull], "[]");

		const made = await githubAuthoring(exec).propose(topic);

		expect(made.ref.id).toBe("7");
		expect(posts()).toBe(2);
	});

	it("says so when the second create answers with nothing too", async () => {
		const { exec, posts } = answering(["", ""], "[]");

		await expect(githubAuthoring(exec).propose(topic)).rejects.toThrow(
			"GitHub answered proposing topic onto main with nothing, twice, and no pull request from topic is open.",
		);
		expect(posts()).toBe(2);
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

		const merged = calls.find((call) => call.args.join(" ").includes("merge"));
		const sent = JSON.parse(merged?.input ?? "{}") as Record<string, unknown>;
		expect(sent.sha).toBe("abc123");
	});

	it("passes the method when one is named", async () => {
		const { exec, calls } = fakeExec([{ when: ["merge"], stdout: "{}" }]);

		await githubAuthoring(exec).merge(ref, { method: "squash" });

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.merge_method).toBe("squash");
	});

	it("sends no method when none is named and the repo takes merge commits", async () => {
		// Leaving it out asks GitHub for a merge commit, which is what a
		// repo that allows them has always had from here.
		const { exec, calls } = fakeExec([
			{ when: ["merge"], stdout: "{}" },
			{ when: ["repos/o/r"], stdout: '{"allow_merge_commit":true}' },
		]);

		await githubAuthoring(exec).merge(ref, {});

		const merged = calls.find((call) => call.args.join(" ").includes("merge"));
		const sent = JSON.parse(merged?.input ?? "{}") as Record<string, unknown>;
		expect(sent).not.toHaveProperty("merge_method");
	});

	it("merges the way the repo allows when none is named", async () => {
		// Leaving the method out is not neutral: GitHub reads it as a merge
		// commit, and five merges in a week failed on repos that forbid
		// them. The repo's own settings say which ways it takes.
		const { exec, calls } = fakeExec([
			{ when: ["merge"], stdout: "{}" },
			{
				when: ["repos/o/r"],
				stdout:
					'{"allow_merge_commit":false,"allow_squash_merge":true,"allow_rebase_merge":true}',
			},
		]);

		await githubAuthoring(exec).merge(ref, {});

		const merged = calls.find((call) => call.args.join(" ").includes("merge"));
		const sent = JSON.parse(merged?.input ?? "{}") as Record<string, unknown>;
		expect(sent.merge_method).toBe("squash");
	});

	it("joins the merge queue where the repo requires one", async () => {
		// GitHub refuses the merge endpoint outright on a queued branch,
		// and the agent was left to find the queue by hand.
		const { exec, calls } = fakeExec([
			{
				when: ["pulls/7/merge"],
				code: 1,
				stderr: "gh: Changes must be made through the merge queue (HTTP 405)",
			},
			{ when: ["repos/o/r/pulls/7"], stdout: '{"node_id":"PR_kw7"}' },
			{ when: ["enqueuePullRequest"], stdout: "{}" },
		]);

		const outcome = await githubAuthoring(exec).merge(ref, {
			expectedHead: "abc123",
		});

		expect(outcome.kind).toBe("enqueued");
		const queued = calls.find((call) =>
			call.args.join(" ").includes("enqueuePullRequest"),
		);
		expect(queued?.args.join(" ")).toContain("id=PR_kw7");
		expect(queued?.args.join(" ")).toContain("head=abc123");
	});

	it("says a change already in the queue is queued, not failed", async () => {
		const { exec } = fakeExec([
			{
				when: ["pulls/7/merge"],
				code: 1,
				stderr: "gh: Pull Request is in the merge queue. (HTTP 405)",
			},
		]);

		const outcome = await githubAuthoring(exec).merge(ref, {});

		expect(outcome).toEqual({
			kind: "enqueued",
			detail: "already in the merge queue",
		});
	});
});

describe("requesting reviewers", () => {
	it("sends the people asked for", async () => {
		const { exec, calls } = fakeExec([
			{
				when: ["requested_reviewers"],
				stdout: recorded(["wren", "finch"], []),
			},
		]);

		await githubAuthoring(exec).requestReviewers?.(ref, ["wren", "finch"]);

		const sent = JSON.parse(calls[0]?.input ?? "{}") as Record<string, unknown>;
		expect(sent.reviewers, "each person is sent as a reviewer").toEqual([
			"wren",
			"finch",
		]);
		expect(sent.team_reviewers, "no team is sent").toEqual([]);
	});

	it("sends a team of the repo's org by its slug", async () => {
		// GitHub drops a team sent as a person and still answers success,
		// so `o/reviewers` has to go as the team slug `reviewers`.
		const { exec, calls } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren"], ["reviewers"]),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
		]);

		await githubAuthoring(exec).requestReviewers?.(ref, [
			"wren",
			"@o/reviewers",
		]);

		const sent = JSON.parse(
			callMatching(calls, "POST")?.input ?? "{}",
		) as Record<string, unknown>;
		expect(sent.reviewers, "only the person goes as a reviewer").toEqual([
			"wren",
		]);
		expect(sent.team_reviewers, "the team goes by its slug").toEqual([
			"reviewers",
		]);
	});

	it("refuses a team of another org before asking anybody", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["requested_reviewers"], stdout: recorded(["wren"], []) },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren", "elsewhere/ci"]),
			"a team GitHub can't take is refused",
		).rejects.toThrow(/only teams of the repo's own org, o.*Nobody was asked/);
		expect(calls, "nothing reaches GitHub").toEqual([]);
	});

	it("names whoever GitHub took the request for and didn't record", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren"], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren", "o/ci"]),
			"a success that recorded nobody for the team is no success",
		).rejects.toThrow(
			/recorded no request for team ci\. It did record wren, so ask again only for the rest\./,
		);
	});

	it("says whether anybody was asked is unknown when the answer shows nothing", async () => {
		const { exec } = fakeExec([
			{ when: ["requested_reviewers"], stdout: "not json" },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren"]),
			"an unreadable answer is not read as success",
		).rejects.toThrow(/whether anybody was asked is unknown/);
	});

	it("matches what GitHub recorded whatever its case", async () => {
		const { exec } = fakeExec([
			{ when: ["requested_reviewers"], stdout: recorded(["Wren"], []) },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren"]),
			"logins are not case-sensitive on GitHub",
		).resolves.toBeUndefined();
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

	it("names a person GitHub dropped, and who it did record", async () => {
		const { exec } = fakeExec([
			{ when: ["requested_reviewers"], stdout: recorded(["wren"], []) },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren", "finch"]),
			"the dropped person named, the recorded one said as recorded",
		).rejects.toThrow(
			/recorded no request for finch\. It did record wren, so ask again only for the rest\./,
		);
	});

	it("says it's unknown when the answer holds only one of the lists", async () => {
		const { exec } = fakeExec([
			{
				when: ["requested_reviewers"],
				stdout: JSON.stringify({ requested_reviewers: [{ login: "wren" }] }),
			},
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren"]),
			"an answer missing the teams list says nothing of teams",
		).rejects.toThrow(/whether anybody was asked is unknown/);
	});

	it("asks a person-only list in one call, reading nothing first", async () => {
		const { exec, calls } = fakeExec([
			{ when: ["requested_reviewers"], stdout: recorded(["wren"], []) },
		]);

		await githubAuthoring(exec).requestReviewers?.(ref, ["wren"]);

		expect(calls, "only the request itself").toHaveLength(1);
	});

	it("says it's unknown when the answer holds neither list", async () => {
		const { exec } = fakeExec([
			{ when: ["requested_reviewers"], stdout: "{}" },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren"]),
			"an object without the lists is not a request recorded for nobody",
		).rejects.toThrow(/whether anybody was asked is unknown/);
	});

	it("takes the repo's org and a team slug whatever their case", async () => {
		const { exec, calls } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren"], ["reviewers"]),
			},
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["@wren ", "O/Reviewers"]),
			"orgs and team slugs are not case-sensitive on GitHub",
		).resolves.toBeUndefined();
		const sent = JSON.parse(
			callMatching(calls, "POST")?.input ?? "{}",
		) as Record<string, unknown>;
		expect(sent.reviewers, "the person trimmed and without its @").toEqual([
			"wren",
		]);
		expect(
			sent.team_reviewers,
			"the slug lowercased, as GitHub keeps it",
		).toEqual(["reviewers"]);
	});

	it("refuses a name no login or team could be before asking anybody", async () => {
		const refusals: [string, RegExp][] = [
			[" ", /names nobody/],
			["@", /names nobody/],
			["@ wren", /isn't a GitHub login/],
			["wren finch", /isn't a GitHub login/],
			["wren,finch", /isn't a GitHub login/],
			["o/", /isn't a team GitHub can name/],
			["o/.", /isn't a team GitHub can name/],
			["o/..", /isn't a team GitHub can name/],
			["o/.ci", /isn't a team GitHub can name/],
			["/x", /isn't a team GitHub can name/],
			["o/a/b", /isn't a team GitHub can name/],
			["o/ ci", /isn't a team GitHub can name/],
			["o /ci", /isn't a team GitHub can name/],
		];
		for (const [name, why] of refusals) {
			const { exec, calls } = fakeExec([
				{ when: ["requested_reviewers"], stdout: recorded(["wren"], []) },
			]);

			const asking = githubAuthoring(exec).requestReviewers?.(ref, [
				"wren",
				name,
			]);
			await expect(asking, `"${name}" is refused, saying why`).rejects.toThrow(
				why,
			);
			await expect(asking, `"${name}" asks nobody`).rejects.toThrow(
				/Nobody was asked\./,
			);
			expect(calls, `nothing reaches GitHub for "${name}"`).toEqual([]);
		}
	});

	it("counts a team handed on to its members as asked", async () => {
		// GitHub's code review assignment removes the team and requests
		// some of its members in its place.
		const { exec, calls } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren", "earlier", "picked"], []),
			},
			{
				when: ["requested_reviewers"],
				stdout: requestedEarlier(["earlier"], []),
			},
			{ when: ["teams/ci/memberships/picked"], stdout: ACTIVE_MEMBER },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren", "o/ci"]),
			"a member of the team nobody named appeared in its place",
		).resolves.toBeUndefined();
		const read = calls.findIndex(
			(call) =>
				call.args.some((arg) => arg.endsWith("/requested_reviewers")) &&
				!call.args.includes("POST"),
		);
		const asked = calls.findIndex((call) => call.args.includes("POST"));
		expect(read, "who was requested is read").toBeGreaterThanOrEqual(0);
		expect(read, "and read before the request, not after").toBeLessThan(asked);
		expect(
			callMatching(calls, "orgs/o/teams/ci/memberships/picked"),
			"the newcomer's membership is read from the repo's org",
		).toBeDefined();
	});

	it("doesn't take a newcomer who isn't the team's member as the team handed on", async () => {
		// A code owner's request landing between the read and the ask would
		// otherwise hide a dropped team.
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren", "owner"], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
			{ when: ["memberships/owner"], code: 1, stderr: "HTTP 404" },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren", "o/ci"]),
			"dropped, with the doubt said and no ask-again advice",
		).rejects.toThrow(
			/recorded no request for team ci\. It did record wren\. Owner appeared unasked, and team ci may have been handed on to them .*check the pull request's reviewers before asking again/,
		);
	});

	it("says a team may have gone to someone also asked by name who is its member", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren"], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
			{ when: ["teams/ci/memberships/wren"], stdout: ACTIVE_MEMBER },
		]);

		const asking = githubAuthoring(exec).requestReviewers?.(ref, [
			"wren",
			"o/ci",
		]);
		await expect(
			asking,
			"dropped, saying wren may stand for it, with no ask-again advice",
		).rejects.toThrow(
			/recorded no request for team ci\. It did record wren\. Team ci may have been handed on to wren, who was also asked by name and is its member; check the pull request's reviewers before asking again/,
		);
		await expect(asking, "no advice to ask only the rest").rejects.not.toThrow(
			/ask again only for the rest/,
		);
	});

	it("doesn't take a pending membership as the team handed on", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["picked"], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
			{
				when: ["teams/ci/memberships/picked"],
				stdout: JSON.stringify({ state: "pending", role: "member" }),
			},
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["o/ci"]),
			"an invitation not yet taken is no membership",
		).rejects.toThrow(
			/recorded no request for team ci\. Picked appeared unasked, and team ci may have been handed on/,
		);
	});

	it("lets one newcomer stand for one team, saying a second may share them", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["picked"], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
			{ when: ["teams/ci/memberships/picked"], stdout: ACTIVE_MEMBER },
			{ when: ["teams/qa/memberships/picked"], stdout: ACTIVE_MEMBER },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["o/ci", "o/qa"]),
			"picked counts for ci, so qa is dropped with the doubt",
		).rejects.toThrow(
			/recorded no request for team qa\. It did record team ci\. Team qa may have been handed on to picked \(for team ci\), already counted for another team; check/,
		);
	});

	it("counts each team on its own members, so a dropped one beside one handed on is said", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["picked"], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], []) },
			{ when: ["teams/ci/memberships/picked"], stdout: ACTIVE_MEMBER },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["o/ci", "o/typo"]),
			"typo has no member among the newcomers",
		).rejects.toThrow(
			/recorded no request for team typo\. It did record team ci\./,
		);
	});

	it("doesn't take someone requested earlier as a team handed on", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["wren", "earlier"], []),
			},
			{
				when: ["requested_reviewers"],
				stdout: JSON.stringify({ users: [{ login: "earlier" }], teams: [] }),
			},
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["wren", "o/ci"]),
			"nobody new appeared, so the team was dropped",
		).rejects.toThrow(
			/recorded no request for team ci\. It did record wren, so ask again only for the rest\./,
		);
	});

	it("takes nobody as handed on when who was requested before can't be read", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded(["picked"], []),
			},
			{ when: ["requested_reviewers"], code: 1, stderr: "HTTP 502" },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["o/ci"]),
			"dropped, saying it may have been handed on as the list was unread",
		).rejects.toThrow(
			/recorded no request for team ci\. Who was requested before couldn't be read, so team ci may have been handed on/,
		);
	});

	it("doesn't take a team requested earlier as recorded when the answer lacks it", async () => {
		const { exec } = fakeExec([
			{
				when: ["POST", "requested_reviewers"],
				stdout: recorded([], []),
			},
			{ when: ["requested_reviewers"], stdout: requestedEarlier([], ["ci"]) },
		]);

		await expect(
			githubAuthoring(exec).requestReviewers?.(ref, ["o/ci"]),
			"nobody new appeared, so dropped without a doubt",
		).rejects.toThrow(/recorded no request for team ci\. Check the name/);
	});
});

describe("reviewers no ask could take", () => {
	it("says why from the names alone, calling nothing", () => {
		const { exec, calls } = fakeExec([]);
		const authoring = githubAuthoring(exec);

		expect(
			authoring.reviewersRefusal?.(repo, ["wren", "elsewhere/ci"]),
			"another org's team refused",
		).toMatch(/only teams of the repo's own org, o\. Nobody was asked\./);
		expect(
			authoring.reviewersRefusal?.(repo, ["wren", "o/ci"]),
			"an askable list passes",
		).toBeUndefined();
		expect(
			authoring.reviewersRefusal?.({ key: "gitlab:o/r" }, ["o/ci"]),
			"a key that isn't GitHub's says so",
		).toMatch(/gitlab:o\/r is not a GitHub repo key/);
		expect(calls, "nothing reaches GitHub").toEqual([]);
	});
});

/** GitHub's answer for a login that is an active member of a team. */
const ACTIVE_MEMBER = JSON.stringify({ state: "active", role: "member" });

/** Who a pull request had requested, as its requested_reviewers route lists them. */
function requestedEarlier(logins: string[], slugs: string[]): string {
	return JSON.stringify({
		users: logins.map((login) => ({ login })),
		teams: slugs.map((slug) => ({ slug })),
	});
}

/** A pull request answer recording these logins and team slugs. */
function recorded(logins: string[], slugs: string[]): string {
	return JSON.stringify({
		requested_reviewers: logins.map((login) => ({ login })),
		requested_teams: slugs.map((slug) => ({ slug })),
	});
}

/** Which rerun routes were POSTed, in order. */
function routesRerun(calls: { args: string[] }[]): string[] {
	return calls.flatMap((call) => {
		const route = call.args.find((arg) => arg.endsWith("/rerun"));
		return route ? [route] : [];
	});
}

describe("asking CI to run again", () => {
	/** The head read, then the runs listed for it. */
	function ciAnswers(runs: string) {
		return [
			{ when: ["pr", "view", "headRefOid"], stdout: "abc123\n" },
			{ when: ["actions/runs?head_sha=abc123"], stdout: runs },
			// The POST answers empty, which is what the API does. Listed
			// after the query above because a reply matches on fragments
			// and `/rerun` is what tells the two apart.
			{ when: ["/rerun"], stdout: "" },
		];
	}

	it("reruns every run on the head commit", async () => {
		const { exec, calls } = fakeExec(ciAnswers("11\tCI\n12\tLint\n"));

		const outcome = await githubAuthoring(exec).rerun?.(ref);

		expect(outcome).toEqual({ kind: "started" });
		// Found by shape rather than by position: `send` appends
		// `--input <tempfile>`, so the last argument is never the route.
		expect(routesRerun(calls)).toEqual([
			"repos/o/r/actions/runs/11/rerun",
			"repos/o/r/actions/runs/12/rerun",
		]);
	});

	it("reruns only the pipeline named", async () => {
		const { exec, calls } = fakeExec(ciAnswers("11\tCI\n12\tLint\n"));

		const outcome = await githubAuthoring(exec).rerun?.(ref, "Lint");

		expect(outcome).toEqual({ kind: "started", which: "Lint" });
		expect(routesRerun(calls)).toEqual(["repos/o/r/actions/runs/12/rerun"]);
	});

	// The case that decides whether this feature is honest. A check can be
	// reported by an app that has no Actions run behind it, and answering
	// "started" there leaves somebody waiting on a build nobody queued.
	it("declines rather than reporting a start, when nothing can be rerun", async () => {
		const { exec, calls } = fakeExec(ciAnswers(""));

		const outcome = await githubAuthoring(exec).rerun?.(ref);

		expect(outcome?.kind).toBe("declined");
		expect(outcome).toMatchObject({
			reason: expect.stringContaining("no GitHub Actions run exists"),
		});
		expect(routesRerun(calls)).toEqual([]);
	});

	it("declines by name when the pipeline asked for is not there", async () => {
		const { exec } = fakeExec(ciAnswers("11\tCI\n"));

		const outcome = await githubAuthoring(exec).rerun?.(ref, "Nightly");

		expect(outcome).toMatchObject({
			kind: "declined",
			reason: expect.stringContaining("Nightly"),
		});
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
