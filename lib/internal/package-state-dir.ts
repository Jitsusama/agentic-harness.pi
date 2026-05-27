/**
 * Package-scoped state directory resolution.
 *
 * Extensions in this package persist artifacts (reviewer
 * runs, supervised stream logs, fix-worktree admin state) to
 * disk between sessions. Each extension gets its own
 * subdirectory under a single package-wide root so multiple
 * pi packages can coexist on the same machine without
 * stepping on each other's state.
 *
 * Path layout:
 *
 *     ${XDG_STATE_HOME ?? ~/.local/state}/pi/agentic-harness.pi/<extension>/
 *
 * The `pi/` segment is shared across all pi extension
 * packages; the `agentic-harness.pi/` segment scopes to this
 * package; the trailing `<extension>` segment isolates one
 * extension's files from its siblings.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Brand string used to scope state to this pi package. */
const PACKAGE_DIR = "agentic-harness.pi";

/**
 * Resolve the on-disk state directory for one extension in
 * this package. Honours `XDG_STATE_HOME` when set to a
 * non-empty value, falls back to `~/.local/state` otherwise.
 * Per the XDG Base Directory Specification, an empty
 * `$XDG_STATE_HOME` is treated identically to an unset one
 * — otherwise `join("", ...)` would silently yield a
 * cwd-relative path and write state next to wherever the
 * user happened to be standing.
 *
 * Does not create the directory: callers are responsible
 * for `mkdir -p` when they first write to it.
 */
export function packageStateDir(extension: string): string {
	const xdg = process.env.XDG_STATE_HOME;
	const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
	return join(root, "pi", PACKAGE_DIR, extension);
}
