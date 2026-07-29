/**
 * The diff model, in git's own dialect.
 *
 * Every backend surveyed can produce a unified diff, and
 * unified diff is the only representation all of them share,
 * so it is the substrate's diff currency. A file has an old
 * side and a new side, which is what git calls them; the
 * forge convention of "left" and "right" stays inside the
 * providers that invented it.
 */

/** How a file changed between the two sides. */
export type DiffStatus = "added" | "deleted" | "modified" | "renamed";

/**
 * Which side of the diff something sits on. Git's own words:
 * the forge convention of "left" and "right" stays inside the
 * providers that invented it.
 */
export type DiffSide = "old" | "new";

/** One line of a hunk, numbered on whichever sides hold it. */
export interface DiffLine {
	kind: "context" | "added" | "removed";
	/** Line number on the old side, when it exists there. */
	oldLine?: number;
	/** Line number on the new side, when it exists there. */
	newLine?: number;
	/** Line content, without the leading marker. */
	text: string;
}

/** A contiguous run of changed lines. */
export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** Heading git guessed for the enclosing section. */
	section?: string;
	lines: DiffLine[];
}

/** One file's worth of diff. */
export interface DiffFile {
	/** Path on the old side; absent when the file was added. */
	oldPath?: string;
	/** Path on the new side; absent when the file was deleted. */
	newPath?: string;
	status: DiffStatus;
	/** Blob id of the old side, when the diff reports it. */
	oldBlob?: string;
	/** Blob id of the new side, when the diff reports it. */
	newBlob?: string;
	/** Rename similarity percentage, for renames. */
	similarity?: number;
	/** True when git declined to show content. */
	binary?: boolean;
	hunks: DiffHunk[];
}

/** A parsed unified diff. */
export interface DiffModel {
	files: DiffFile[];
}

/**
 * The `@@` line for this hunk, as git would write it.
 *
 * Reconstructed from the parts rather than kept as text,
 * because a provider that built a hunk itself never had the
 * line, and storing both invites them to disagree. Git omits
 * the count when a range covers exactly one line, so this does
 * too: the header is fed back to tools that expect git's own
 * spelling.
 */
export function hunkHeader(hunk: DiffHunk): string {
	const side = (start: number, count: number) =>
		count === 1 ? `${start}` : `${start},${count}`;
	const range = `@@ -${side(hunk.oldStart, hunk.oldCount)} +${side(hunk.newStart, hunk.newCount)} @@`;
	return hunk.section ? `${range} ${hunk.section}` : range;
}

/**
 * The one path this file is known by, for matching and lookup.
 *
 * The new side wins, falling back to the old for a file that
 * was deleted. Distinct from `displayPath` on purpose: a label
 * can say a file moved, but anything comparing paths needs a
 * single real one, and a rename shown as a journey would match
 * nothing.
 */
export function filePath(file: DiffFile): string {
	return file.newPath ?? file.oldPath ?? "";
}

/**
 * The path to put in front of a person.
 *
 * The new side by default, since that is where the code now
 * lives, but a rename says both halves: a reader who knows the
 * old name needs to find it, and one who knows neither needs
 * to see that the move happened at all.
 */
export function displayPath(file: DiffFile): string {
	if (file.status === "renamed" && file.oldPath && file.newPath) {
		return `${file.oldPath} -> ${file.newPath}`;
	}
	return filePath(file);
}

/**
 * How many lines this file added and removed.
 *
 * Counted from the hunks rather than carried as a field,
 * because a diff that arrived as text has no other source and
 * a second source would be a second thing to get wrong. A
 * binary file has no hunks and so counts as neither.
 */
export function changeCounts(file: DiffFile): {
	additions: number;
	deletions: number;
} {
	let additions = 0;
	let deletions = 0;
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			if (line.kind === "added") additions += 1;
			else if (line.kind === "removed") deletions += 1;
		}
	}
	return { additions, deletions };
}

/**
 * This line's number on one side, when it exists there.
 *
 * An added line has no old number and a removed line has no
 * new one, so the answer is honestly absent rather than zero.
 */
export function lineNumberOn(
	line: DiffLine,
	side: DiffSide,
): number | undefined {
	return side === "old" ? line.oldLine : line.newLine;
}

const FILE_HEADER = /^diff --git /;
const FILE_HEADER_PATHS = /^diff --git a\/(.+) b\/(.+)$/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/;
const SIMILARITY_LINE = /^similarity index (\d+)%/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const NO_NEWLINE = /^\\ No newline/;

/** A file being assembled while walking the diff. */
interface PartialFile extends DiffFile {
	status: DiffStatus;
	hunks: DiffHunk[];
}

/**
 * Start a file from its `diff --git` header. The header is
 * the only place a binary file or a bare mode change names
 * its paths, since git omits the `---` and `+++` pair for
 * those; when the pair is present it overrides these.
 */
function startFile(header: string): PartialFile {
	const file: PartialFile = { status: "modified", hunks: [] };
	const paths = FILE_HEADER_PATHS.exec(header);
	if (paths) {
		file.oldPath = paths[1];
		file.newPath = paths[2];
	}
	return file;
}

/**
 * Strip the `a/` or `b/` prefix git puts on diff paths.
 * `/dev/null` means the file does not exist on that side.
 */
function diffPath(raw: string): string | undefined {
	if (raw === "/dev/null") return undefined;
	return raw.replace(/^[ab]\//, "");
}

function readHunkHeader(line: string): DiffHunk | undefined {
	const match = HUNK_HEADER.exec(line);
	if (!match) return undefined;
	const [, oldStart, oldCount, newStart, newCount, section] = match;
	return {
		oldStart: Number(oldStart),
		// git omits the count when the range covers one line.
		oldCount: oldCount === undefined ? 1 : Number(oldCount),
		newStart: Number(newStart),
		newCount: newCount === undefined ? 1 : Number(newCount),
		...(section ? { section } : {}),
		lines: [],
	};
}

/**
 * Append one body line to a hunk, numbering it on whichever
 * sides it exists on. Returns the advanced cursors.
 */
function readBodyLine(
	hunk: DiffHunk,
	line: string,
	oldLine: number,
	newLine: number,
): { oldLine: number; newLine: number } {
	const text = line.slice(1);
	if (line.startsWith("+")) {
		hunk.lines.push({ kind: "added", newLine, text });
		return { oldLine, newLine: newLine + 1 };
	}
	if (line.startsWith("-")) {
		hunk.lines.push({ kind: "removed", oldLine, text });
		return { oldLine: oldLine + 1, newLine };
	}
	hunk.lines.push({ kind: "context", oldLine, newLine, text });
	return { oldLine: oldLine + 1, newLine: newLine + 1 };
}

/**
 * Read one of the header lines that sit between a file
 * header and its first hunk: paths, mode changes, renames,
 * blob ids and the binary marker.
 */
function readFileHeader(file: PartialFile, line: string): void {
	if (line.startsWith("--- ")) {
		file.oldPath = diffPath(line.slice(4));
		return;
	}
	if (line.startsWith("+++ ")) {
		file.newPath = diffPath(line.slice(4));
		return;
	}
	if (line.startsWith("new file mode")) {
		file.status = "added";
		// The header named both sides; an added file has no old one.
		file.oldPath = undefined;
		return;
	}
	if (line.startsWith("deleted file mode")) {
		file.status = "deleted";
		file.newPath = undefined;
		return;
	}
	if (line.startsWith("rename from ")) {
		file.status = "renamed";
		file.oldPath = line.slice("rename from ".length);
		return;
	}
	if (line.startsWith("rename to ")) {
		file.status = "renamed";
		file.newPath = line.slice("rename to ".length);
		return;
	}
	if (line.startsWith("Binary files")) {
		file.binary = true;
		return;
	}

	const similarity = SIMILARITY_LINE.exec(line);
	if (similarity) {
		file.similarity = Number(similarity[1]);
		return;
	}
	const index = INDEX_LINE.exec(line);
	if (index) {
		file.oldBlob = index[1];
		file.newBlob = index[2];
	}
}

/**
 * Parse git's unified diff output into a `DiffModel`.
 *
 * Tolerant by design: a diff arrives from whichever backend
 * produced it, so an unrecognized header line is skipped
 * rather than treated as an error.
 */
export function parseUnifiedDiff(text: string): DiffModel {
	const files: DiffFile[] = [];
	let file: PartialFile | undefined;
	let hunk: DiffHunk | undefined;
	let oldLine = 0;
	let newLine = 0;

	for (const line of text.split("\n")) {
		if (FILE_HEADER.test(line)) {
			file = startFile(line);
			files.push(file);
			hunk = undefined;
			continue;
		}
		if (!file) continue;

		const header = readHunkHeader(line);
		if (header) {
			hunk = header;
			file.hunks.push(hunk);
			oldLine = hunk.oldStart;
			newLine = hunk.newStart;
			continue;
		}

		if (hunk) {
			// The no-newline marker annotates the line above it
			// rather than being a line of its own.
			if (NO_NEWLINE.test(line)) continue;
			if (line === "") continue;
			({ oldLine, newLine } = readBodyLine(hunk, line, oldLine, newLine));
			continue;
		}

		readFileHeader(file, line);
	}

	return { files };
}
