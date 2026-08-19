import type { RepoLocator } from "@jitsusama/agentic-harness.core/review";
import { describe, expect, it } from "vitest";
import { treeSource } from "../../../lib/work/tree.js";

describe("treeSource", () => {
	it("uses a checkout the substrate already found", () => {
		const repo: RepoLocator = {
			key: "github:Shopify/world",
			localPath: "/Users/someone/src/github.com/Shopify/world",
			remoteUrl: "https://github.com/Shopify/world.git",
		};

		expect(treeSource(repo)).toEqual({
			kind: "checkout",
			path: "/Users/someone/src/github.com/Shopify/world",
		});
	});

	it("asks for a clone when only the remote is known", () => {
		const repo: RepoLocator = {
			key: "github:Shopify/world",
			remoteUrl: "https://github.com/Shopify/world.git",
		};

		expect(treeSource(repo)).toEqual({
			kind: "clone",
			remoteUrl: "https://github.com/Shopify/world.git",
		});
	});

	it("refuses rather than guessing when it knows neither", () => {
		expect(treeSource({ key: "meteorite:shop/world" })).toEqual({
			kind: "unknown",
			repoKey: "meteorite:shop/world",
		});
	});

	it("never invents a filesystem path for a repo it cannot place", () => {
		// The failure this exists to prevent: the old provider
		// resolved a source repo as ~/src/github.com/{owner}/{repo},
		// which is correct on GitHub and silently wrong everywhere
		// else. A repo we cannot place is unknown, not guessed, so
		// the answer carries no path at all rather than a plausible
		// one. Echoing the repo's own key back is fine; deriving a
		// directory from it is not.
		const source = treeSource({ key: "meteorite:shop/world" });

		expect(source).not.toHaveProperty("path");
		expect(JSON.stringify(source)).not.toContain("/src/");
		expect(JSON.stringify(source)).not.toContain("github.com");
	});

	it("prefers the checkout even when a remote is also known, since a local repo is the cheaper source", () => {
		const repo: RepoLocator = {
			key: "meteorite:shop/world",
			localPath: "/Users/someone/world/trees/root/src",
			remoteUrl: "https://gitstream.shopify.io/shop/world.git",
		};

		expect(treeSource(repo)).toEqual({
			kind: "checkout",
			path: "/Users/someone/world/trees/root/src",
		});
	});

	it("treats an empty local path as no local path", () => {
		const repo: RepoLocator = {
			key: "github:Shopify/world",
			localPath: "",
			remoteUrl: "https://github.com/Shopify/world.git",
		};

		expect(treeSource(repo)).toEqual({
			kind: "clone",
			remoteUrl: "https://github.com/Shopify/world.git",
		});
	});

	it("treats an empty remote as no remote", () => {
		expect(treeSource({ key: "git:local", remoteUrl: "" })).toEqual({
			kind: "unknown",
			repoKey: "git:local",
		});
	});
});
