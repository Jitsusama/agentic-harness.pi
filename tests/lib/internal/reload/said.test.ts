import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LOADED_FOLDER,
	packageFolderOf,
	sayLoaded,
	unsayLoaded,
} from "../../../../lib/internal/reload/said.ts";

let root: string;
let install: string;
let version: string;
beforeEach(() => {
	// Resolved, as a pi's own root is: the temporary folder may be a link.
	root = realpathSync(mkdtempSync(join(tmpdir(), "said-")));
	install = join(root, "github.com", "Jitsusama", "agentic-harness.pi");
	version = join(install, "versions", "57be3af7");
	mkdirSync(version, { recursive: true });
	symlinkSync(join("versions", "57be3af7"), join(install, "current"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The file a pi said it loaded in, which a test needs it to have said. */
function written(file: string | undefined): string {
	if (file === undefined) throw new Error("the pi said nothing");
	return file;
}

const said = (file: string | undefined) =>
	JSON.parse(readFileSync(written(file), "utf8"));

describe("what a pi says it loaded", () => {
	it("says the version it runs in its install's loaded folder, whole", () => {
		const file = sayLoaded(version, join(install, "current"), 4242);

		expect(file).toBe(join(install, LOADED_FOLDER, "4242"));
		expect(said(file)).toEqual({ root: version });
		expect(readdirSync(join(install, LOADED_FOLDER))).toEqual(["4242"]);
	});

	it("says a tree it runs in the install pi's settings name", () => {
		const tree = join(root, "trees", "harness");
		mkdirSync(tree, { recursive: true });

		const file = sayLoaded(tree, join(install, "current"), 4242);

		expect(file).toBe(join(install, LOADED_FOLDER, "4242"));
		expect(said(file)).toEqual({ root: tree });
	});

	it("says again at each load, the last load's answer replacing the first", () => {
		const next = join(install, "versions", "d3082480");
		mkdirSync(next);
		sayLoaded(version, undefined, 4242);

		const file = sayLoaded(next, undefined, 4242);

		expect(said(file)).toEqual({ root: next });
		expect(readdirSync(join(install, LOADED_FOLDER))).toEqual(["4242"]);
	});

	it("says nothing of a package pi-packages doesn't keep", () => {
		const tree = join(root, "trees", "harness");
		mkdirSync(tree, { recursive: true });

		expect(packageFolderOf(tree, undefined)).toBeUndefined();
		expect(packageFolderOf(tree, join(root, "nowhere"))).toBeUndefined();
		expect(sayLoaded(tree, undefined, 4242)).toBeUndefined();
		expect(existsSync(join(install, LOADED_FOLDER))).toBe(false);
	});

	it("takes it back as the pi ends", () => {
		const file = written(sayLoaded(version, undefined, 4242));

		unsayLoaded(file);

		expect(existsSync(file)).toBe(false);
	});
});
