import { describe, expect, it } from "vitest";
import { isGeneratedPath } from "../../../extensions/pr-workflow/generated-files.js";

// Reviewers waste attention and prompt budget on generated
// output nobody hand-edits. isGeneratedPath recognizes the
// well-known generated and vendored files so the reviewer
// prompt can omit their diff, while staying conservative so
// ordinary source is never hidden.

describe("isGeneratedPath", () => {
	it("matches lockfiles regardless of directory", () => {
		for (const path of [
			"pnpm-lock.yaml",
			"package-lock.json",
			"yarn.lock",
			"go.sum",
			"Cargo.lock",
			"poetry.lock",
			"composer.lock",
			"Gemfile.lock",
			"services/api/go.sum",
		]) {
			expect(isGeneratedPath(path)).toBe(true);
		}
	});

	it("matches minified assets, snapshots and protobuf output", () => {
		for (const path of [
			"dist/app.min.js",
			"public/site.min.css",
			"tests/__snapshots__/x.test.ts.snap",
			"proto/user.pb.go",
			"proto/user_pb2.py",
		]) {
			expect(isGeneratedPath(path)).toBe(true);
		}
	});

	it("matches vendored and generated trees", () => {
		for (const path of [
			"vendor/github.com/pkg/errors/errors.go",
			"node_modules/left-pad/index.js",
			"generated/schema.ts",
			"app/__generated__/types.ts",
		]) {
			expect(isGeneratedPath(path)).toBe(true);
		}
	});

	it("leaves ordinary source paths alone", () => {
		for (const path of [
			"lib/subagent/subagent.ts",
			"extensions/pr-workflow/index.ts",
			"src/main.go",
			"README.md",
			"app/models/user.rb",
			"a-vendored-thing/real.ts",
			"src/lockfile-parser.ts",
		]) {
			expect(isGeneratedPath(path)).toBe(false);
		}
	});
});
