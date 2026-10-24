import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	awaitedSessions,
	carryLeases,
	changeOf,
	changeSubject,
	changesOf,
	claimsCheckout,
	createBoard,
	holdingFrom,
	type Lease,
	leaseEventFrom,
	othersIn,
	othersOn,
	ownLeases,
	RUN_KINDS,
	rewriteIn,
} from "../../../lib/mesh/lease.ts";
import { senderOf } from "../../../lib/mesh/transport.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-lease-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const at = Date.parse("2026-10-22T05:00:00Z");
const minutes = (count: number) => count * 60 * 1000;

function lease(over: Partial<Lease> = {}): Lease {
	return {
		kind: "change",
		subject: "widget:src/a.ts",
		since: new Date(at).toISOString(),
		until: new Date(at + minutes(10)).toISOString(),
		...over,
	};
}

describe("the board", () => {
	it("keeps each peer's leases in a file of its own, gone when it holds none", () => {
		const board = createBoard(join(root, "leases"));

		board.hold({ session: "one", leases: [lease()] });
		board.hold({ session: "two/x", leases: [lease({ kind: "hold" })] });

		expect(board.of("one")?.leases).toEqual([lease()]);
		expect(board.all().map(({ session }) => session)).toEqual(["one", "two/x"]);
		board.hold({ session: "one", leases: [] });
		expect(existsSync(join(root, "leases", "one.json"))).toBe(false);
		expect(board.all().map(({ session }) => session)).toEqual(["two/x"]);
	});

	it("carries a peer's leases to the session it carries on in", () => {
		const board = createBoard(join(root, "leases"));
		const held = lease({ kind: "hold", subject: "1-a" });
		const waited = lease({ kind: "wait", subject: "2-b" });
		board.hold({ session: "old", leases: [held] });
		board.hold({ session: "new", leases: [waited] });

		carryLeases(board, "old", "new");

		expect(board.of("new")?.leases).toEqual([waited, held]);
		expect(board.of("old")).toBeUndefined();
		carryLeases(board, "new", "new");
		expect(board.of("new")?.leases).toEqual([waited, held]);
	});

	it("reads as empty before any peer has written to it", () => {
		expect(createBoard(join(root, "nowhere")).all()).toEqual([]);
	});
});

describe("a holding as read", () => {
	it("keeps only the leases that read", () => {
		expect(
			holdingFrom({
				session: "one",
				leases: [
					lease({ why: "a test" }),
					{ ...lease(), kind: "lock" },
					{ ...lease(), until: 5 },
					"x",
				],
			}),
		).toEqual({ session: "one", leases: [lease({ why: "a test" })] });
	});

	it("keeps the peer a hand claimed it for", () => {
		expect(
			holdingFrom({ session: "me.hand.1", leases: [], handOf: "me" }),
		).toEqual({ session: "me.hand.1", leases: [], handOf: "me" });
		expect(
			holdingFrom({ session: "me.hand.1", leases: [], handOf: "" }),
		).toEqual({ session: "me.hand.1", leases: [] });
	});

	it("is nothing without a session and its leases", () => {
		expect(holdingFrom({ leases: [] })).toBeUndefined();
		expect(holdingFrom({ session: "one" })).toBeUndefined();
		expect(holdingFrom(null)).toBeUndefined();
	});
});

describe("who the live peers wait on", () => {
	it("is the sender of a hold a live peer is parked on, and its hands", () => {
		const wait = (subject: string, over: Partial<Lease> = {}) =>
			lease({ kind: "wait", subject, ...over });
		const board = [
			{ session: "waiter", leases: [wait("1792698000000-P9R1KI-5402-aaaa")] },
			// Gone from the census, so whatever it waits on no longer counts.
			{ session: "ended", leases: [wait("1792698000000-WCJQSG-7-bbbb")] },
			{
				session: "lapsed",
				leases: [
					wait("1792698000000-2HN63P-8-cccc", {
						until: new Date(at).toISOString(),
					}),
				],
			},
			{ session: "hand", handOf: "holder", leases: [lease()] },
		];
		const present = [
			{ session: "waiter", addresses: ["LUQ49E"] },
			{ session: "lapsed", addresses: ["X7FXPL"] },
			{ session: "holder", addresses: ["P9R1KI", "26502274"] },
			{ session: "launcher", addresses: ["WCJQSG"] },
			{ session: "stick", addresses: ["2HN63P"] },
		];

		expect([...awaitedSessions(board, present, at)].sort()).toEqual([
			"hand",
			"holder",
		]);
		expect(senderOf("1792698000000-P9R1KI-5402-aaaa")).toBe("P9R1KI");
		expect(senderOf("not-a-stamp")).toBeUndefined();
	});
});

describe("what a peer is changing now", () => {
	it("is its standing change leases, latest first, each once and at most twelve", () => {
		const older = lease({ subject: "widget:src/old.ts" });
		const later = (subject: string, plus: number) =>
			lease({ subject, since: new Date(at + minutes(plus)).toISOString() });
		const leases = [
			older,
			later("widget:src/new.ts", 2),
			later("widget:src/old.ts", 1),
			lease({ kind: "answer", subject: "1-WCJQSG-1-aaaa" }),
			lease({
				subject: "widget:src/lapsed.ts",
				until: new Date(at).toISOString(),
			}),
		];

		expect(changesOf(leases, at)).toEqual([
			"widget:src/new.ts",
			"widget:src/old.ts",
		]);
		const many = Array.from({ length: 15 }, (_, one) =>
			later(`widget:src/${one}.ts`, one),
		);
		expect(changesOf(many, at)).toHaveLength(12);
		expect(changesOf(many, at)[0]).toBe("widget:src/14.ts");
	});
});

describe("others on a subject", () => {
	it("are the other peers' current leases of that kind on it", () => {
		const board = [
			{ session: "me", leases: [lease()] },
			{
				session: "them",
				leases: [
					lease(),
					lease({ kind: "answer" }),
					lease({ subject: "widget:src/b.ts" }),
				],
			},
			{
				session: "lapsed",
				leases: [lease({ until: new Date(at - 1).toISOString() })],
			},
		];

		expect(othersOn(board, "me", "change", "widget:src/a.ts", at)).toEqual([
			{ session: "them", lease: lease() },
		]);
	});

	it("count a hand's leases as its peer's, and never a peer's own hands or the peer a hand works for", () => {
		const board = [
			{ session: "me", leases: [lease()] },
			{ session: "me.hand.1", handOf: "me", leases: [lease()] },
			{ session: "them.hand.2", handOf: "them", leases: [lease()] },
		];

		expect(othersOn(board, "me", "change", "widget:src/a.ts", at)).toEqual([
			{ session: "them", lease: lease() },
		]);
		// A hand leases as its peer, so neither its peer nor itself is other.
		expect(othersOn(board, "them", "change", "widget:src/a.ts", at)).toEqual([
			{ session: "me", lease: lease() },
			{ session: "me", lease: lease() },
		]);
	});
});

describe("a change's subject", () => {
	it("is alike in two worktrees of one repository", () => {
		const main = join(root, "main");
		mkdirSync(join(main, ".git", "worktrees", "other"), { recursive: true });
		writeFileSync(
			join(main, ".git", "config"),
			'[remote "origin"]\n\turl = git@github.com:someone/widget.git\n',
		);
		writeFileSync(
			join(main, ".git", "worktrees", "other", "commondir"),
			"../..\n",
		);
		const other = join(root, "other");
		mkdirSync(join(other, "src"), { recursive: true });
		writeFileSync(
			join(other, ".git"),
			`gitdir: ${join(main, ".git", "worktrees", "other")}\n`,
		);
		mkdirSync(join(main, "src"), { recursive: true });

		const here = changeSubject("src/a.ts", main);
		const there = changeSubject(join(other, "src", "a.ts"), root);

		expect(here).toMatch(/widget:src\/a\.ts$/);
		expect(there).toBe(here);
	});

	it("is the absolute path outside any checkout", () => {
		expect(changeSubject("notes.md", root)).toBe(join(root, "notes.md"));
	});

	it("says which checkout it is in, and the board keeps that", () => {
		const main = checkout("main");
		mkdirSync(join(main, "src"));
		const board = createBoard(join(root, "leases"));
		const change = changeOf("src/a.ts", main);
		const own = ownLeases(board, "me", at);
		own.take("change", change.subject, minutes(10), undefined, at, main);

		expect(change.checkout).toBe(main);
		expect(changeOf("notes.md", root).checkout).toBeUndefined();
		expect(board.of("me")?.leases[0]?.checkout).toBe(main);
	});
});

function checkout(name: string): string {
	const path = join(root, name);
	mkdirSync(join(path, ".git"), { recursive: true });
	return path;
}

describe("a command that rewrites a checkout", () => {
	it("is a git command that changes the files, where it runs", () => {
		const main = checkout("main");
		const other = checkout("other");

		expect(rewriteIn("git checkout main", main)).toEqual({
			checkout: main,
			command: "git checkout main",
			catchesUp: false,
		});
		expect(rewriteIn(`cd ${other} && git reset --hard HEAD~1`, main)).toEqual({
			checkout: other,
			command: "git reset --hard HEAD~1",
			catchesUp: false,
		});
		expect(rewriteIn(`git -C ${other} stash`, main)?.checkout).toBe(other);
		expect(rewriteIn("git pull -q --ff-only origin main", main)).toEqual({
			checkout: main,
			command: "git pull -q --ff-only origin main",
			catchesUp: true,
		});
		for (const run of [
			"switch fix",
			"checkout -b fix origin/main",
			"stash pop",
			"rebase origin/main",
			"pull --ff-only",
			"clean -fd",
			"restore src",
			"-c core.pager=cat merge fix",
		]) {
			expect(rewriteIn(`git ${run}`, main)?.checkout).toBe(main);
		}
	});

	it("is nothing for git that leaves the files as they are, or outside a checkout", () => {
		const main = checkout("main");

		for (const run of [
			"status",
			"checkout -b fix",
			"switch -c fix",
			"reset HEAD~1",
			"stash list",
			"clean -n",
			"clean -fn",
			"commit -m wip",
			"push",
		]) {
			expect(rewriteIn(`git ${run}`, main)).toBeUndefined();
		}
		expect(rewriteIn('echo "git checkout main"', main)).toBeUndefined();
		expect(rewriteIn("git checkout main", root)).toBeUndefined();
	});

	it("is nothing where the shell names the folder, not the session's checkout", () => {
		const main = checkout("main");
		const other = checkout("other");

		for (const command of [
			"cd $C && git rebase -q -i --autosquash origin/main",
			'cd "$C" && git rebase origin/main',
			`cd "${other}" && git rebase origin/main`,
			"cd $(git rev-parse --show-toplevel) && git stash",
			"cd - && git checkout main",
			"cd $C && cd src && git reset --hard",
			"git -C $C rebase origin/main",
			'git -C "$C" rebase origin/main',
		]) {
			expect(rewriteIn(command, main), command).toBeUndefined();
		}
		expect(
			rewriteIn(`cd $C && cd ${other} && git rebase origin/main`, main)
				?.checkout,
		).toBe(other);
	});
});

describe("other peers in a checkout", () => {
	it("are those changing files or all of it there, not in another worktree", () => {
		const here = { checkout: "/src/widget" };
		const file = lease(here);
		const whole = lease({ subject: "/src/widget", ...here });
		const board = [
			{ session: "me", leases: [lease(here)] },
			{ session: "two", leases: [file, lease({ kind: "answer", ...here })] },
			{ session: "two.hand", handOf: "two", leases: [whole] },
			{ session: "three", leases: [lease({ checkout: "/src/widget-2" })] },
			{
				session: "four",
				leases: [lease({ ...here, until: new Date(at).toISOString() })],
			},
		];

		expect(othersIn(board, "me", "/src/widget", at)).toEqual([
			{ session: "two", lease: file },
			{ session: "two", lease: whole },
		]);
		expect(claimsCheckout(whole)).toBe(true);
		expect(claimsCheckout(file)).toBe(false);
		expect(holdingFrom(board[2])?.leases).toEqual([whole]);
	});
});

describe("a peer's own leases", () => {
	it("keep what outlives a run, and drop what a run took or what lapsed", () => {
		const board = createBoard(join(root, "leases"));
		board.hold({
			session: "me",
			leases: [
				lease({ kind: "hold", subject: "kept" }),
				lease({ kind: "change" }),
				lease({ kind: "answer", subject: "asked" }),
				lease({
					kind: "wait",
					subject: "lapsed",
					until: new Date(at - 1).toISOString(),
				}),
			],
		});

		const own = ownLeases(board, "me", at);

		expect(own.leases.map(({ subject }) => subject)).toEqual(["kept"]);
		expect(board.of("me")?.leases.map(({ subject }) => subject)).toEqual([
			"kept",
		]);
	});

	it("are written again only when renewing moves their end a minute or more", () => {
		const dir = join(root, "leases");
		const own = ownLeases(createBoard(dir), "me", at);
		const file = join(dir, "me.json");

		const taken = own.take("change", "x", minutes(10), undefined, at);
		const written = readFileSync(file, "utf8");
		const kept = own.take("change", "x", minutes(10), undefined, at + 59_000);
		expect(kept).toBe(taken);
		expect(readFileSync(file, "utf8")).toBe(written);

		const renewed = own.take(
			"change",
			"x",
			minutes(10),
			undefined,
			at + 60_000,
		);
		expect(renewed.since).toBe(taken.since);
		expect(renewed.until).toBe(new Date(at + minutes(11)).toISOString());
		expect(readFileSync(file, "utf8")).not.toBe(written);
	});

	it("are given up one at a time, or a run's all at once", () => {
		const board = createBoard(join(root, "leases"));
		const own = ownLeases(board, "me", at);
		own.take("change", "x", minutes(10), undefined, at);
		own.take("answer", "q", minutes(10), undefined, at);
		own.take("hold", "h", minutes(10), "builds", at);

		expect(own.release("hold", "h")?.why).toBe("builds");
		expect(own.release("hold", "h")).toBeUndefined();
		expect(own.held("change", "x", at)).toBeDefined();
		own.releaseAll(RUN_KINDS);
		expect(own.leases).toEqual([]);
		expect(board.of("me")).toBeUndefined();
	});

	it("name the peer a hand takes them for", () => {
		const dir = join(root, "leases");
		const own = ownLeases(createBoard(dir), "me.hand.1", at, "me");

		own.take("heavy", "nix", minutes(10), undefined, at);

		expect(createBoard(dir).of("me.hand.1")?.handOf).toBe("me");
	});

	it("are not held past their end", () => {
		const own = ownLeases(createBoard(join(root, "leases")), "me", at);
		own.take("hold", "h", minutes(1), undefined, at);

		expect(own.held("hold", "h", at + minutes(1))).toBeUndefined();
	});
});

describe("the lease event", () => {
	it("takes or releases heavy work by its subject", () => {
		expect(
			leaseEventFrom({ take: { subject: " qemu ", why: "vm test", ms: 5 } }),
		).toEqual({ take: { subject: "qemu", why: "vm test", ms: 5 } });
		expect(leaseEventFrom({ take: { subject: "qemu", ms: -1 } })).toEqual({
			take: { subject: "qemu" },
		});
		expect(leaseEventFrom({ release: "qemu" })).toEqual({ release: "qemu" });
	});

	it("is nothing without a subject", () => {
		expect(leaseEventFrom({ take: { subject: "" } })).toBeUndefined();
		expect(leaseEventFrom({ release: " " })).toBeUndefined();
		expect(leaseEventFrom({ take: "qemu" })).toBeUndefined();
		expect(leaseEventFrom("qemu")).toBeUndefined();
	});
});
