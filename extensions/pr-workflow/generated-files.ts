/**
 * Conservative recognition of generated and vendored files.
 *
 * Reviewers waste attention and prompt budget on output
 * nobody hand-edits (lockfiles, minified bundles, vendored
 * trees). This predicate names the well-known cases so the
 * reviewer prompt can omit their diff. It stays deliberately
 * conservative: a false negative (reviewing a generated file)
 * is cheap, but a false positive (hiding real source) loses
 * a finding, so only unambiguous markers match.
 */

/** Exact file names that are always generated, in any directory. */
const LOCKFILE_NAMES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"go.sum",
	"cargo.lock",
	"poetry.lock",
	"composer.lock",
	"gemfile.lock",
]);

/** Path suffixes that mark generated output. */
const GENERATED_SUFFIXES = [
	".min.js",
	".min.css",
	".snap",
	".pb.go",
	"_pb2.py",
];

/** Path segments whose presence marks a vendored or generated tree. */
const GENERATED_SEGMENTS = new Set([
	"vendor",
	"node_modules",
	"generated",
	"__generated__",
]);

/**
 * Return true when `path` is a generated or vendored file
 * the reviewer should not spend attention on.
 */
export function isGeneratedPath(path: string): boolean {
	const normalized = path.trim().replace(/\\/g, "/");
	if (normalized === "") return false;
	const lower = normalized.toLowerCase();

	const baseName = lower.slice(lower.lastIndexOf("/") + 1);
	if (LOCKFILE_NAMES.has(baseName)) return true;

	if (GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;

	const segments = lower.split("/");
	return segments.some((segment) => GENERATED_SEGMENTS.has(segment));
}
