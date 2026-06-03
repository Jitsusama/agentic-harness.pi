import { afterEach, describe, expect, it } from "vitest";
import {
	clearTreeProviders,
	getTreeProvider,
	listTreeProviders,
	registerBuiltinTreeProviders,
	registerTreeProvider,
	resolveTreeProvider,
	type TreeHandle,
	type TreeProvider,
	unregisterTreeProvider,
} from "../../../lib/tree";

function stubProvider(
	id: string,
	priority: number,
	applies: (repoRoot: string) => boolean,
): TreeProvider {
	return {
		id,
		priority,
		appliesTo: applies,
		async create(): Promise<TreeHandle> {
			return {
				path: `/stub/${id}`,
				providerId: id,
			};
		},
		async prune(): Promise<void> {
			// no-op stub
		},
	};
}

afterEach(() => clearTreeProviders());

describe("tree provider registry", () => {
	it("registers, retrieves and unregisters providers", () => {
		const provider = stubProvider("a", 50, () => true);
		registerTreeProvider(provider);
		expect(getTreeProvider("a")).toBe(provider);
		expect(listTreeProviders()).toHaveLength(1);
		unregisterTreeProvider("a");
		expect(getTreeProvider("a")).toBeUndefined();
	});

	it("seeds the built-in git-worktree provider", () => {
		registerBuiltinTreeProviders();
		const found = getTreeProvider("git-worktree");
		expect(found?.id).toBe("git-worktree");
		expect(found?.priority).toBe(100);
	});
});

describe("resolveTreeProvider", () => {
	it("returns undefined when nothing applies", () => {
		registerTreeProvider(stubProvider("never", 10, () => false));
		expect(resolveTreeProvider("/anywhere")).toBeUndefined();
	});

	it("picks the lowest priority among applicable providers", () => {
		registerTreeProvider(stubProvider("low", 10, () => true));
		registerTreeProvider(stubProvider("high", 100, () => true));
		const resolved = resolveTreeProvider("/anywhere");
		expect(resolved?.id).toBe("low");
	});

	it("skips providers whose appliesTo returns false", () => {
		registerTreeProvider(
			stubProvider("only-world", 50, (p) => p.startsWith("/world")),
		);
		registerTreeProvider(stubProvider("fallback", 100, () => true));
		expect(resolveTreeProvider("/world/foo")?.id).toBe("only-world");
		expect(resolveTreeProvider("/elsewhere")?.id).toBe("fallback");
	});
});
