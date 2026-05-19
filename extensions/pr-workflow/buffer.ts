/**
 * `pi://pr/...` buffer support.
 *
 * Defines the URI scheme, parser, constructor and file
 * resolver used by neovim-pi when it asks pr-workflow to
 * supply buffer content. Everything in this module is pure:
 * the fetcher is injected so the resolver stays testable.
 *
 * URI shape (file view, head side):
 *
 *   pi://pr/<owner>/<repo>/<number>/file/<sha>/<path>
 *
 * The SHA is baked into the URI so the resolver doesn't need
 * to consult workflow state. Path segments after the SHA are
 * joined and percent-decoded into a single filesystem path.
 */

/** Parsed shape of a pi://pr file URI. */
export interface ParsedPrFileUri {
	readonly scheme: "pr-file";
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly sha: string;
	readonly path: string;
}

/** Buffer content returned to the neovim-pi resolver. */
export interface PrBufferContent {
	readonly lines: string[];
	readonly filetype?: string;
}

/** Fetcher signature: get file contents at a specific ref. */
export type PrFileFetcher = (
	owner: string,
	repo: string,
	ref: string,
	path: string,
) => Promise<string>;

const PR_FILE_PATTERN =
	/^pi:\/\/pr\/([^/]+)\/([^/]+)\/(\d+)\/file\/([^/]+)\/(.+)$/;

/**
 * Parse a `pi://pr/.../file/...` URI. Returns null for any
 * other shape so the dispatcher can route elsewhere.
 */
export function parsePrFileUri(uri: string): ParsedPrFileUri | null {
	const match = uri.match(PR_FILE_PATTERN);
	if (!match) return null;
	const number = Number.parseInt(match[3], 10);
	if (!Number.isFinite(number)) return null;
	return {
		scheme: "pr-file",
		owner: match[1],
		repo: match[2],
		number,
		sha: match[4],
		path: decodeURIComponent(match[5]),
	};
}

/** Construct a `pi://pr/.../file/...` URI from its parts. */
export function prFileUri(input: {
	owner: string;
	repo: string;
	number: number;
	sha: string;
	path: string;
}): string {
	const encodedPath = input.path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `pi://pr/${input.owner}/${input.repo}/${input.number}/file/${input.sha}/${encodedPath}`;
}

/**
 * Resolve a parsed URI to buffer content. The fetcher pulls
 * the raw file string; this function splits it into lines
 * and attaches a filetype hint. Errors from the fetcher are
 * caught and surfaced as an error buffer rather than thrown,
 * so the user sees something useful in nvim instead of a
 * blank failure.
 */
export async function resolvePrFile(
	parsed: ParsedPrFileUri,
	fetcher: PrFileFetcher,
): Promise<PrBufferContent> {
	try {
		const content = await fetcher(
			parsed.owner,
			parsed.repo,
			parsed.sha,
			parsed.path,
		);
		return {
			lines: content.split("\n"),
			filetype: inferFiletype(parsed.path),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			lines: [
				`pr-workflow: failed to load ${parsed.owner}/${parsed.repo}#${parsed.number}:${parsed.path}`,
				`at sha ${parsed.sha}`,
				"",
				message,
			],
		};
	}
}

const FILETYPE_MAP: Record<string, string> = {
	ts: "typescript",
	tsx: "typescriptreact",
	js: "javascript",
	jsx: "javascriptreact",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	md: "markdown",
	mdx: "markdown",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
	fish: "fish",
	lua: "lua",
	vim: "vim",
	css: "css",
	scss: "scss",
	html: "html",
	htm: "html",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	php: "php",
	sql: "sql",
	dockerfile: "dockerfile",
	graphql: "graphql",
	gql: "graphql",
};

/**
 * Guess a vim filetype from a path. Returns undefined when
 * the extension isn't recognized; nvim's own detection runs
 * in that case.
 */
export function inferFiletype(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	if (dot === -1 || dot === path.length - 1) return undefined;
	const ext = path.slice(dot + 1).toLowerCase();
	return FILETYPE_MAP[ext];
}
