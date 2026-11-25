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
 * `modules/` it is three, where core.nix keeps a module. A folder that says how code is laid out rather
 * than what it is about is climbed past to its parent, so
 * `modules/quickshell/checks` is `modules/quickshell`: replayed over a
 * week of needs, leaving it drew every need saying checks to the
 * launcher's cell. Tests, docs, a repository's own config and its root
 * files name no area, since everyone touches them. Nor do World's zones
 * under `areas/` yet: said by their names they would hold words such as
 * shopify and dev, which many needs carry, and no World landing was in
 * the replay that measured these rules.
 */

/** The most areas one landing says: past this a change is a sweep. */
export const MOST_AREAS = 24;

/** How deep an area reads under each top folder, two elsewhere. */
const DEPTH: Readonly<Record<string, number>> = { modules: 3 };
const DEFAULT_DEPTH = 2;

/** Top folders whose files name no area. */
const NO_AREA = new Set(["tests", "test", "docs", ".github", ".pi", "areas"]);

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
	const folders = path.split("/").slice(0, -1);
	const top = folders[0];
	if (top === undefined || NO_AREA.has(top)) return undefined;
	const kept = folders.slice(0, DEPTH[top] ?? DEFAULT_DEPTH);
	while (kept.length > 1 && LAYOUT.has(kept.at(-1) ?? "")) kept.pop();
	return kept.length > 1 ? kept.join("/") : undefined;
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
