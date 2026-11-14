/**
 * The GPU inside the fence: every fenced command has the render nodes
 * and never a card node or the by-path links.
 */

import { describe, expect, it } from "vitest";
import { fenceArgs } from "../../../lib/internal/fence.ts";
import type { Disk } from "../../../lib/internal/fence-disk.ts";

/** A disk with a GPU: a card node, two render nodes and a by-path folder. */
const withGpu: Disk = {
	kind: (path) => {
		if (path === "/dev/dri/by-path") return "folder";
		if (path.startsWith("/dev/dri/")) return "file";
		return path.split("/").includes(".git") ? undefined : "folder";
	},
	entries: (folder) =>
		folder === "/dev/dri"
			? ["card0", "renderD129", "renderD128", "by-path"]
			: [],
};

const place = { home: "/home/someone", runtimeDir: "/run/user/1000" };

/** Every path bubblewrap is told to bind from under /dev/dri. */
function driBound(args: readonly string[]): string[] {
	return args.filter((arg) => arg.startsWith("/dev/dri"));
}

describe("the GPU inside the fence", () => {
	it("binds each render node, in order, with nothing to ask", () => {
		expect(
			fenceArgs(place, withGpu).join(" "),
			"both render nodes are bound, lowest first",
		).toContain(
			"--dev-bind /dev/dri/renderD128 /dev/dri/renderD128 --dev-bind /dev/dri/renderD129 /dev/dri/renderD129",
		);
	});

	it("never binds a card node or the by-path links", () => {
		const bound = driBound(fenceArgs(place, withGpu));
		expect(
			bound.filter((path) => path.includes("card")),
			"no card node is bound",
		).toEqual([]);
		expect(
			bound.filter((path) => path.includes("by-path")),
			"no by-path link is bound",
		).toEqual([]);
	});

	it("binds nothing on a machine with no GPU", () => {
		const noGpu: Disk = { kind: () => "folder", entries: () => [] };
		expect(
			driBound(fenceArgs(place, noGpu)),
			"nothing under /dev/dri is bound",
		).toEqual([]);
	});
});
