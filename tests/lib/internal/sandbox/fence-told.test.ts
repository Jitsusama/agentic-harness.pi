/**
 * A hosted session's tools tell its host the fence they hold it to, a
 * refused sandbox as strict since no command runs under it; a tell the
 * host couldn't write reads false, so the tool refuses what it would
 * run, and nothing else throws into a tool's load or call.
 */

import { describe, expect, it } from "vitest";
import type { FenceTeller, Host } from "../../../../lib/core/session/host.ts";
import {
	fenceOf,
	tellHostFence,
	tellHostLeft,
} from "../../../../lib/internal/sandbox/fence-told.ts";
import type { Sandbox } from "../../../../lib/internal/sandbox/sandbox.ts";
import type { FenceKind } from "../../../../lib/mesh/presence.ts";

const none = { kind: "none" } as Sandbox;
const strict = { kind: "strict" } as Sandbox;
const fence = { kind: "fence" } as Sandbox;
const refused = { kind: "refused", reason: "no landrun" } as Sandbox;

type Told = [string, FenceKind | "left", FenceTeller?][];

function host(
	told: Told,
	answer: "written" | "unwritten" | "gone" | "broken",
): Host {
	return {
		holds: () => (answer === "gone" ? undefined : "idle"),
		fenced: (session: string, kind: FenceKind, by: FenceTeller) => {
			if (answer === "gone") throw new Error(`not held: ${session}`);
			if (answer === "broken") throw new Error("partway through a write");
			told.push([session, kind, by]);
			return answer === "written";
		},
		left: (session: string) => {
			if (answer === "gone") throw new Error(`not held: ${session}`);
			told.push([session, "left"]);
		},
	} as unknown as Host;
}

describe("fenceOf", () => {
	it("names each sandbox's fence, a refused one as strict", () => {
		expect([none, strict, fence, refused].map(fenceOf)).toEqual([
			"none",
			"strict",
			"fence",
			"strict",
		]);
	});
});

describe("tellHostFence", () => {
	it("tells the host the fence, and who holds it there, of the session its tool runs in", () => {
		const told: Told = [];
		expect(
			tellHostFence(
				"fence",
				"shell",
				{ PI_SESSION_ID: "a" },
				host(told, "written"),
			),
			"a written tell read as unwritten",
		).toBe(true);
		expect(told).toEqual([["a", "fence", "shell"]]);
	});

	it("tells nothing without a session, or outside a host, and lets the tool run", () => {
		const told: Told = [];
		expect(
			tellHostFence("fence", "files", {}, host(told, "written")),
			"refused without a session",
		).toBe(true);
		expect(told).toEqual([]);
		expect(
			tellHostFence("fence", "files", { PI_SESSION_ID: "a" }, undefined),
			"refused outside a host",
		).toBe(true);
	});

	it("says a tell the host couldn't write, so the tool refuses", () => {
		expect(
			tellHostFence(
				"fence",
				"files",
				{ PI_SESSION_ID: "a" },
				host([], "unwritten"),
			),
			"an unwritten tell let the tool run",
		).toBe(false);
	});

	it("lets a tool run in a host that holds no such session, whose record names it nowhere", () => {
		expect(
			tellHostFence("fence", "files", { PI_SESSION_ID: "a" }, host([], "gone")),
			"refused where the record names no such session",
		).toBe(true);
	});

	it("refuses where the host still holds the session but its tell broke partway", () => {
		expect(
			tellHostFence(
				"fence",
				"files",
				{ PI_SESSION_ID: "a" },
				host([], "broken"),
			),
			"a broken tell let the tool run under a record it may not match",
		).toBe(false);
	});
});

describe("tellHostLeft", () => {
	it("tells the host a guard of the session's runner left, and never throws", () => {
		const told: Told = [];
		tellHostLeft("a", host(told, "written"));
		tellHostLeft(undefined, host(told, "written"));
		expect(told, "a runner that heard no session told one").toEqual([
			["a", "left"],
		]);
		expect(() => tellHostLeft("a", host([], "gone"))).not.toThrow();
	});
});
