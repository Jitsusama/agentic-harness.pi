import { describe, expect, it } from "vitest";
import {
	asksRepos,
	parking,
	type Session,
} from "../../../../lib/internal/pineapple/park.ts";
import { type Stop, stopOf } from "../../../../lib/internal/pineapple/stops.ts";

function stop(...reaches: string[]): Stop {
	const made = stopOf({ shadow: false, reaches }, reaches.join("+"));
	if (!made) throw new Error("a stop with no resume is made");
	return made;
}

const session: Session = {
	realm: "work",
	quests: ["QEST-CHILD", "QEST-PARENT"],
	repos: ["example/shop"],
	dirs: ["/work/shop", "/trees/shop-checkout-fix"],
};

const parkedBy = (stops: Stop[], who: Session = session) =>
	parking(stops, who).map((one) => one.stop.id);

describe("parking", () => {
	it("parks every session for everything", () => {
		expect(parkedBy([stop("everything")])).toEqual(["everything"]);
	});

	it("parks a realm's sessions, and one naming no realm, but not another realm's", () => {
		expect(parkedBy([stop("realm:work")])).toEqual(["realm:work"]);
		expect(parkedBy([stop("realm:home")])).toEqual([]);
		expect(
			parkedBy([stop("realm:home")], { ...session, realm: undefined }),
		).toEqual(["realm:home"]);
	});

	it("parks a quest's sessions and those of quests under it", () => {
		expect(parkedBy([stop("quest:qest-parent")])).toEqual([
			"quest:qest-parent",
		]);
		expect(parkedBy([stop("quest:QEST-OTHER")])).toEqual([]);
	});

	it("parks a repository's sessions, the owner or not", () => {
		expect(parkedBy([stop("repo:example/shop")])).toEqual([
			"repo:example/shop",
		]);
		expect(parkedBy([stop("repo:shop")])).toEqual(["repo:shop"]);
		expect(parkedBy([stop("repo:example/other")])).toEqual([]);
		expect(
			parkedBy([stop("repo:example/shop")], { ...session, repos: [] }),
		).toEqual([]);
	});

	it("parks what a name is part of: a repository, a folder or a quest", () => {
		expect(parkedBy([stop("named:checkout")])).toEqual(["named:checkout"]);
		expect(parkedBy([stop("named:aquifer")])).toEqual([]);
	});

	it("parks nobody for one change, which the write guard holds alone", () => {
		expect(
			parkedBy([stop("pr:example/shop#12"), stop("branch:example/shop@fix")]),
		).toEqual([]);
	});

	it("says why, by the first reach that parks", () => {
		const [one] = parking(
			[stop("pr:example/shop#12", "quest:QEST-CHILD")],
			session,
		);
		expect(one?.reach).toEqual({ kind: "quest", id: "QEST-CHILD" });
		expect(one?.because).toContain("QEST-CHILD");
	});
});

describe("asksRepos", () => {
	it("asks only when a stop could park by repository or name", () => {
		expect({
			wider: asksRepos([stop("quest:QEST-A"), stop("everything")]),
			repo: asksRepos([stop("repo:example/shop")]),
			named: asksRepos([stop("named:aquifer")]),
		}).toEqual({ wider: false, repo: true, named: true });
	});
});
