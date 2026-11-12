import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LOADED_FOLDER,
	packageFolderOf,
	runningPi,
	sayLoaded,
	sayLoadedIn,
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
	// A host sets it; the tests here say which pi runs where they mean to.
	vi.stubEnv("PI_PACKAGE_DIR", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

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
		const loaded = join(install, LOADED_FOLDER);
		expect(
			existsSync(loaded),
			`${loaded} is not made for a package pi-packages does not keep`,
		).toBe(false);
	});

	it("says a new root in the file it said in before, where no install can be found", () => {
		const tree = join(root, "trees", "harness");
		mkdirSync(tree, { recursive: true });
		const file = written(sayLoaded(version, undefined, 4242));

		expect(sayLoaded(tree, tree, 4242)).toBeUndefined();
		expect(sayLoadedIn(file, tree)).toBe(file);

		expect(said(file)).toEqual({ root: tree });
		expect(readdirSync(join(install, LOADED_FOLDER))).toEqual(["4242"]);
	});

	it("says which pi runs it, so pi-packages can warm that pi's cache", () => {
		const pi = {
			bundle: "/store/pi/dist/bundle",
			node: "/store/node/bin/node",
			tmp: "/tmp",
		};

		const file = sayLoaded(version, undefined, 4242, pi);

		expect(said(file)).toEqual({ root: version, pi });
	});

	it("takes it back as the pi ends", () => {
		const file = written(sayLoaded(version, undefined, 4242));

		unsayLoaded(file);

		expect(existsSync(file), `${file} goes as the pi ends`).toBe(false);
	});
});

// 12 November: jiti names its cache entries by each file's path, and
// every swap moves the harness to a new one, so the first start of each
// pi after a swap transpiled all 1,120 files again: 15 s cold against
// 1.4 s warm. pi-packages warms the cache through each pi that runs.
describe("which pi runs", () => {
	const node = "/store/node/bin/node";

	it("is the bundle whose command line started the process", () => {
		const pi = runningPi({
			argv: [node, "/store/pi/lib/node_modules/pi-monorepo/dist/bundle/cli.js"],
			env: {},
			node,
			tmp: "/tmp",
		});

		expect(pi).toEqual({
			bundle: "/store/pi/lib/node_modules/pi-monorepo/dist/bundle",
			node,
			tmp: "/tmp",
		});
	});

	it("is the runtime a host names, which runs a script of its own", () => {
		const runtime = join(root, "pi-host-runtime");
		const bundle = join(runtime, "lib/node_modules/pi-monorepo/dist/bundle");
		mkdirSync(bundle, { recursive: true });
		writeFileSync(join(bundle, "cli.js"), "");

		const pi = runningPi({
			argv: [node, join(version, "scripts/pi-host.ts"), "attended"],
			env: { PI_PACKAGE_DIR: runtime },
			node,
			tmp: "/tmp",
		});

		expect(pi).toEqual({ bundle, node, tmp: "/tmp" });
	});

	it("is nothing when neither says where pi's bundle is", () => {
		const pi = runningPi({
			argv: [node, "/somewhere/vitest.mjs"],
			env: { PI_PACKAGE_DIR: join(root, "no-runtime") },
			node,
			tmp: "/tmp",
		});

		expect(pi, "no pi is named without a bundle to start").toBeUndefined();
	});
});
