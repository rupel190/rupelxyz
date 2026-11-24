// markdown-it-footnote ships no types; this silences the editor warning.
declare module "markdown-it-footnote";
// build.ts runs under Bun and uses its image encoder; bun-types would be a dependency for one name.
declare const Bun: { Image: any };
