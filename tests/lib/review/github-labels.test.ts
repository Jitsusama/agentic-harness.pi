/**
 * Labels and assignees on GitHub, which are not where the change is.
 *
 * GitHub models a pull request as an issue with a branch attached, so
 * `PATCH /pulls/{n}` takes a title, a body and a base and knows nothing
 * about labels. The `/issues/{n}` routes own those. Reading is free
 * because the pull request representation reports them anyway; writing
 * costs a separate call, and these tests pin which one.
 */

import { describe, expect, it } from "vitest";
import { githubAuthoring } from "../../../lib/review/index.js";
import { fakeExec } from "./support/fake-exec.js";

const REPO = { key: "github:Shopify/world" };
const CHANGE = {
	provider: "github",
	repo: REPO,
	id: "42",
	label: "Shopify/world#42",
};

/** A pull request body, with whatever the test wants on it. */
function pull(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		number: 42,
		title: "A change",
		body: "",
		state: "open",
		user: { login: "someone" },
		base: { ref: "main" },
		head: { ref: "topic", sha: "abc" },
		...extra,
	});
}

/** An exec that answers every GitHub call with the same change. */
function scripted() {
	return fakeExec([{ when: ["api"], stdout: pull() }]);
}

describe("reading labels and assignees back", () => {
	it("reads both off the change, since GitHub sends them", async () => {
		const { exec } = fakeExec([
			{
				when: ["api"],
				stdout: pull({
					labels: [{ name: "zone:money" }, { name: "risky" }],
					assignees: [{ login: "evan" }, { login: "joel" }],
				}),
			},
		]);

		const proposal = await githubAuthoring(exec).edit(CHANGE, {
			title: { action: "set", value: "New" },
		});

		expect(proposal.labels).toEqual(["zone:money", "risky"]);
		expect(proposal.assignees).toEqual([{ id: "evan" }, { id: "joel" }]);
	});

	it("keeps an empty list apart from an absent one", async () => {
		// A change with no labels and a backend that did not say are
		// different facts, and only one of them means "nobody looked".
		const { exec } = fakeExec([
			{ when: ["api"], stdout: pull({ labels: [] }) },
		]);

		const proposal = await githubAuthoring(exec).edit(CHANGE, {
			title: { action: "set", value: "New" },
		});

		expect(proposal.labels).toEqual([]);
		expect(proposal.assignees).toBeUndefined();
	});
});

describe("writing labels", () => {
	it("adds through the route that adds, not by replacing", async () => {
		// The whole reason SetEdit exists. A wholesale replace would need
		// to read the current list first and would drop anything added in
		// between.
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, {
			labels: { action: "add", value: ["risky"] },
		});

		const write = calls.find((call) => call.args.includes("POST"));
		expect(write?.args.join(" ")).toContain(
			"repos/Shopify/world/issues/42/labels",
		);
		expect(write?.input).toBe(JSON.stringify({ labels: ["risky"] }));
	});

	it("replaces through the issue when asked to set", async () => {
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, {
			labels: { action: "set", value: ["only-this"] },
		});

		const write = calls.find(
			(call) =>
				call.args.includes("PATCH") &&
				call.args.some((arg) => arg.includes("/issues/42")),
		);
		expect(write?.input).toBe(JSON.stringify({ labels: ["only-this"] }));
	});

	it("names each label in the path when removing, as GitHub wants", async () => {
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, {
			labels: { action: "remove", value: ["risky", "zone:money"] },
		});

		const removed = calls
			.filter((call) => call.args.includes("DELETE"))
			.map((call) => call.args.find((arg) => arg.includes("/labels/")));
		expect(removed).toEqual([
			"repos/Shopify/world/issues/42/labels/risky",
			"repos/Shopify/world/issues/42/labels/zone%3Amoney",
		]);
	});

	it("escapes a label that would otherwise break the path", async () => {
		// Zone labels carry colons and slashes, and a raw slash would make
		// GitHub read the rest as another route segment.
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, {
			labels: { action: "remove", value: ["team/core"] },
		});

		expect(
			calls.some((call) =>
				call.args.some((arg) => arg.endsWith("/labels/team%2Fcore")),
			),
		).toBe(true);
	});

	it("empties the set when clearing", async () => {
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, { labels: { action: "clear" } });

		const write = calls.find((call) => call.args.includes("PATCH"));
		expect(write?.input).toBe(JSON.stringify({ labels: [] }));
	});

	it("sends nothing at all for an empty add", async () => {
		// An add of nothing is not a clear, and a route that took it as one
		// would strip every label on the change.
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, {
			labels: { action: "add", value: [] },
		});

		expect(calls.filter((call) => call.args.includes("POST"))).toHaveLength(0);
		expect(calls.filter((call) => call.args.includes("PATCH"))).toHaveLength(0);
	});
});

describe("writing assignees", () => {
	it("removes them in one call with a body, unlike labels", async () => {
		// GitHub's own asymmetry: a label is named in the path, assignees
		// come off together in a body.
		const { exec, calls } = scripted();

		await githubAuthoring(exec).edit(CHANGE, {
			assignees: { action: "remove", value: ["evan"] },
		});

		const write = calls.find((call) => call.args.includes("DELETE"));
		expect(write?.args.join(" ")).toContain(
			"repos/Shopify/world/issues/42/assignees",
		);
		expect(write?.input).toBe(JSON.stringify({ assignees: ["evan"] }));
	});
});

describe("proposing with labels", () => {
	it("puts them on afterwards, since the create route will not take them", async () => {
		const { exec, calls } = scripted();

		await githubAuthoring(exec).propose({
			repo: REPO,
			base: "main",
			head: "topic",
			title: "A change",
			body: "",
			draft: false,
			labels: ["risky"],
			assignees: ["joel"],
		});

		const created = calls.find((call) =>
			call.args.some((arg) => arg.endsWith("/pulls")),
		);
		// The create call must not carry them, or GitHub silently ignores
		// them and the caller believes they landed.
		expect(created?.input).not.toContain("risky");
		expect(
			calls.some((call) =>
				call.args.some((arg) => arg.endsWith("/issues/42/labels")),
			),
		).toBe(true);
		expect(
			calls.some((call) =>
				call.args.some((arg) => arg.endsWith("/issues/42/assignees")),
			),
		).toBe(true);
	});
});

describe("an edit that only touches labels", () => {
	it("reads the change back rather than patching it with nothing", async () => {
		const { exec, calls } = scripted();

		const proposal = await githubAuthoring(exec).edit(CHANGE, {
			labels: { action: "add", value: ["risky"] },
		});

		expect(proposal.title).toBe("A change");
		const patchedPull = calls.some(
			(call) =>
				call.args.includes("PATCH") &&
				call.args.some((arg) => arg.endsWith("/pulls/42")),
		);
		expect(patchedPull).toBe(false);
	});
});
