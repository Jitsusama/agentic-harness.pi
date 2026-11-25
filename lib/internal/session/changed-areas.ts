/**
 * The areas of a repository a change touched, said on its landing.
 *
 * A need is routed by the words a cell holds (lib/mesh/need-route.ts),
 * and on 25 November 104 of 122 live cells held only their title's: a
 * broad cell's title names none of its areas, so six needs about the
 * review tools' merge gate went to six different cells and never to the
 * one that owns them. What a session merged says what it works on
 * better than anything it declares, so each merge says the areas it
 * touched, and the mesh says as subjects the ones a quest led
 * (lib/mesh/led-areas.ts).
 *
 * An area is a file's first two folders, as `lib/mesh` or
 * `extensions/review-integration`, since routing reads a subject's
 * narrowest part as its words, and those name a module. Under
 * `modules/` it is three, where core.nix keeps a module, and under
 * `lib/core` too, which holds 22 domains (review, work, quest, session
 * and more): read two deep, a cell leading the review tools' library
 * said only core, and needs about them went to whichever cell's title
 * said a word of theirs. Under `lib/core/internal` it is four, since
 * that holds 14 domains of its own (quest, notes, guardian, lsp and
 * more), so `lib/core/internal/quest` is an area, while a file directly
 * in it climbs to `lib/core`. These apply to any repository's files,
 * though on 25 November only this harness had a `lib/core` among the
 * repositories checked out here. A folder that says how code is laid out rather
 * than what it is about is climbed past to its parent, so
 * `modules/quickshell/checks` is `modules/quickshell`: replayed over a
 * week of needs, leaving it drew every need saying checks to the
 * launcher's cell. Where climbing leaves only the top folder, the area
 * reaches down past the layout folders to the first one that isn't, so
 * `lib/internal/session` is an area of its own rather than none. Tests,
 * specs, docs, a repository's own config (any top folder starting with
 * a dot) and its root files name no area, since everyone touches them,
 * and nor does a path git had to quote, whose name it can't say plainly. Nor do World's zones
 * under `areas/` yet: said by their names they would hold words such as
 * shopify and dev, which many needs carry, and no World landing was in
 * the replay that measured these rules.
 */

/** The most areas one landing says: past this a change is a sweep. */
export const MOST_AREAS = 24;

/**
 * How deep an area reads under each of these folders, two elsewhere;
 * where two hold a file, the deeper folder's.
 */
const DEPTH: ReadonlyMap<string, number> = new Map([
	["modules", 3],
	["lib/core", 3],
	["lib/core/internal", 4],
]);
const DEFAULT_DEPTH = 2;

/** How deep the area of a file in `folders` reads. */
function depthOf(folders: readonly string[]): number {
	for (let at = folders.length; at > 0; at--) {
		const depth = DEPTH.get(folders.slice(0, at).join("/"));
		if (depth !== undefined) return depth;
	}
	return DEFAULT_DEPTH;
}

/** Top folders whose files name no area. */
const NO_AREA = new Set(["tests", "test", "spec", "docs", "areas"]);

/**
 * Folders that say how code is laid out, not what it is about: an area
 * ending in one climbs to its parent.
 */
const LAYOUT = new Set([
	"bin",
	"checks",
	"daemon",
	"docs",
	"fixtures",
	"home",
	"internal",
	"lib",
	"scripts",
	"src",
	"support",
	"test",
	"tests",
	"timers",
	"tools",
]);

/** The area one file is in, or none. */
function areaOf(path: string): string | undefined {
	if (path.startsWith('"')) return undefined;
	const folders = path.split("/").slice(0, -1);
	const top = folders[0];
	if (top === undefined || top.startsWith(".") || NO_AREA.has(top)) {
		return undefined;
	}
	const kept = folders.slice(0, depthOf(folders));
	while (kept.length > 1 && LAYOUT.has(kept.at(-1) ?? "")) kept.pop();
	if (kept.length > 1) return kept.join("/");
	const named = folders.findIndex(
		(folder, at) => at > 0 && !LAYOUT.has(folder),
	);
	return named > 0 ? folders.slice(0, named + 1).join("/") : undefined;
}

/**
 * The areas `paths` are in, those holding most of them first, each
 * once, at most {@link MOST_AREAS}.
 */
export function areasOf(paths: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const area = areaOf(path);
		if (area !== undefined) counts.set(area, (counts.get(area) ?? 0) + 1);
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MOST_AREAS)
		.map(([area]) => area);
}
