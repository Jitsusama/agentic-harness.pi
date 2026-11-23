/**
 * A shell script a test imports, as its text, through the loader in
 * `scripts-as-text.ts`: one ending in `.sh` or `.bash`, or one of the
 * ssh guard's wrappers, which have no ending since an agent's shell
 * finds them by their command's name.
 */
declare module "*.sh" {
	const text: string;
	export default text;
}

declare module "*.bash" {
	const text: string;
	export default text;
}

declare module "*/ssh-guard/bin/ssh" {
	const text: string;
	export default text;
}

declare module "*/ssh-guard/bin/scp" {
	const text: string;
	export default text;
}

declare module "*/ssh-guard/bin/sftp" {
	const text: string;
	export default text;
}

declare module "*/ssh-guard/bin/rsync" {
	const text: string;
	export default text;
}
