import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	reachOf,
	standingStops,
	stopOf,
	stopsFolder,
} from "../../../../lib/internal/pineapple/stops.ts";

describe("reachOf", () => {
	it("reads each reach the reader writes", () => {
		expect(reachOf("everything")).toEqual({ kind: "everything" });
		expect(reachOf("realm:work")).toEqual({ kind: "realm", name: "work" });
		expect(reachOf("pr:Example/Shop#12")).toEqual({
			kind: "pr",
			repo: "example/shop",
			number: 12,
		});
		expect(reachOf("pr:#12")).toEqual({ kind: "pr", number: 12 });
		expect(reachOf("branch:example/shop@fix-it")).toEqual({
			kind: "branch",
			repo: "example/shop",
			name: "fix-it",
		});
		expect(reachOf("branch:@fix-it")).toEqual({
			kind: "branch",
			name: "fix-it",
		});
		expect(reachOf("repo:example/shop")).toEqual({
			kind: "repo",
			repo: "example/shop",
		});
		expect(reachOf("quest:qest-1")).toEqual({ kind: "quest", id: "QEST-1" });
		expect(reachOf("named:Aquifer")).toEqual({
			kind: "named",
			name: "aquifer",
		});
	});

	it("reads a reach it doesn't know as everything, leaning toward stopping", () => {
		expect(reachOf("this-pr")).toEqual({ kind: "everything" });
		expect(reachOf("pr:example/shop#x")).toEqual({ kind: "everything" });
		expect(reachOf("lane:infra")).toEqual({ kind: "everything" });
	});
});

describe("stopOf", () => {
	it("is nothing once Joel has resumed it", () => {
		expect(
			stopOf({ reaches: ["everything"], resumed: { at: 1 } }, "a"),
		).toBeUndefined();
	});

	it("is shadow unless its record says plainly it is live", () => {
		expect(stopOf({ reaches: ["everything"] }, "a")).toMatchObject({
			shadow: true,
		});
		expect(
			stopOf({ reaches: ["everything"], shadow: false }, "a"),
		).toMatchObject({ shadow: false });
	});

	it("reaches everything when its record names no reach", () => {
		expect(stopOf({ shadow: false }, "a")?.reaches).toEqual([
			{ kind: "everything" },
		]);
	});
});

describe("standingStops", () => {
	it("is none where the reader has never written", () => {
		expect(standingStops(join(tmpdir(), "no-such-pineapple-folder"))).toEqual({
			stops: [],
			unreadable: [],
		});
	});

	it("reads standing stops, skips resumed and half-written ones, names unreadable ones", () => {
		const folder = mkdtempSync(join(tmpdir(), "pineapple-stops-"));
		const record = (name: string, body: unknown) =>
			writeFileSync(join(folder, name), JSON.stringify(body));
		record("one.json", {
			id: "slack:C1:1.2",
			shadow: false,
			said_by: "U0OTHER001",
			words: "pineapple override",
			reaches: ["pr:example/shop#12"],
			resumed: null,
		});
		record("two.json", {
			id: "two",
			reaches: ["everything"],
			resumed: { by: "joel" },
		});
		record("three.new", { id: "three", reaches: ["everything"] });
		writeFileSync(join(folder, "four.json"), "{torn");
		const { stops, unreadable } = standingStops(folder);
		expect(stops.map((stop) => stop.id)).toEqual(["slack:C1:1.2"]);
		expect(stops[0]?.saidBy).toBe("U0OTHER001");
		expect(unreadable).toEqual(["four.json"]);
	});
});

describe("stopsFolder", () => {
	it("is under the XDG state folder, or ~/.local/state without one", () => {
		expect(stopsFolder({ XDG_STATE_HOME: "/s" }, "/h")).toBe(
			"/s/pineapple/stops",
		);
		expect(stopsFolder({}, "/h")).toBe("/h/.local/state/pineapple/stops");
	});
});
