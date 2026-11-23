/**
 * A shell script a test imports, as its text, through the loader in
 * `scripts-as-text.ts`.
 */
declare module "*.sh" {
	const text: string;
	export default text;
}
