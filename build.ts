// build.ts — tiny static blog generator for rupel.xyz
//
// Reads Obsidian-friendly Markdown from content/writing/*.md and renders:
//   - /writing/<slug>.html   one page per post (styled to match the site)
//   - /writing/index.html    the writing index
//   - /feed.xml              an RSS feed
//
// Frontmatter (YAML, exactly what Obsidian/Templater write):
//   title, date (YYYY-MM-DD), description, tags: [a, b], draft: true|false, slug?
//
// Run:  bun run build
//
// It's deliberately one readable file — no framework, nothing hidden.

import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import matter from "gray-matter";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Works under both Node and Bun (Bun also has import.meta.dir, but this is portable).
const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "content", "writing");
const OUT = join(ROOT, "writing");
const SITE = "https://rupel.xyz";
const AUTHOR = "Christoph Rippel";

// Christoph's 1-7 rating scale → label. Single source of truth for any post's `rating`.
const RATINGS: Record<number, string> = { 7: "Perfect", 6: "Excellent", 5: "Good", 4: "Passable", 3: "Bad", 2: "Atrocious", 1: "Evil" };

// breaks:true → a single newline becomes <br>, matching how Obsidian renders.
const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true }).use(footnote);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// gray-matter/js-yaml parses an unquoted `date: 2026-06-24` into a Date object — normalize to YYYY-MM-DD.
const toISODate = (d: unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10);
const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return y ? `${MONTHS[(m || 1) - 1]} ${day}, ${y}` : d;
};

type Post = { slug: string; title: string; date: string; description: string; tags: string[]; rating: number | null; html: string };

// --- load + sort ---
if (!existsSync(SRC)) {
  console.error(`No source dir: ${SRC}`);
  process.exit(1);
}
const loaded = readdirSync(SRC)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const { data, content } = matter(readFileSync(join(SRC, f), "utf8"));
    return { slug: (data.slug as string) || basename(f, ".md"), data, content };
  })
  .filter((p) => !p.data.draft)
  .sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)));

// --- [[wikilinks]] → links to published posts, else plain text ---
const lookup = new Map<string, string>();
for (const p of loaded) {
  lookup.set(p.slug.toLowerCase(), p.slug);
  if (p.data.title) lookup.set(String(p.data.title).toLowerCase(), p.slug);
}
const resolveWikilinks = (text: string) =>
  text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
    const slug = lookup.get(String(target).trim().toLowerCase());
    const shown = String(label || target).trim();
    return slug ? `[${shown}](/writing/${slug})` : shown;
  });

const posts: Post[] = loaded.map((p) => ({
  slug: p.slug,
  title: String(p.data.title || p.slug),
  date: toISODate(p.data.date),
  description: String(p.data.description || ""),
  tags: Array.isArray(p.data.tags) ? p.data.tags.map(String) : [],
  rating: p.data.rating != null && p.data.rating !== "" ? Number(p.data.rating) : null,
  html: md.render(resolveWikilinks(p.content)),
}));

// --- shared <head> ---
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&family=Newsreader:ital,wght@0,300;0,400;1,300;1,400&display=swap" rel="stylesheet">`;
const head = (o: { title: string; desc: string; url: string; type?: string; published?: string }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
<meta name="author" content="${AUTHOR}">
<link rel="canonical" href="${o.url}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:type" content="${o.type || "website"}">
<meta property="og:url" content="${o.url}">
<meta property="og:image" content="${SITE}/og-image.png?v=2">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.desc)}">
<meta name="twitter:image" content="${SITE}/og-image.png?v=2">
${o.published ? `<meta property="article:published_time" content="${o.published}">\n` : ""}<link rel="alternate" type="application/rss+xml" title="${AUTHOR} — Writing" href="${SITE}/feed.xml">
${FONTS}
<link rel="stylesheet" href="/assets/blog.css">
</head>`;

// --- post page ---
const postPage = (p: Post) => {
  const url = `${SITE}/writing/${p.slug}`;
  const tags = p.tags.length ? `<span class="tags">${p.tags.map((t) => "#" + esc(t)).join(" ")}</span>` : "";
  const rating = p.rating && RATINGS[p.rating] ? `<span class="rating">${p.rating}/7 &middot; ${RATINGS[p.rating]}</span>` : "";
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: p.title,
    datePublished: p.date,
    author: { "@type": "Person", name: AUTHOR, url: SITE },
    description: p.description,
    mainEntityOfPage: url,
  };
  return `${head({ title: `${p.title} · ${AUTHOR}`, desc: p.description || p.title, url, type: "article", published: p.date })}
<body>
<div class="page post">
  <nav class="topnav"><a href="/">&larr; rupel.xyz</a><a href="/writing/">writing</a></nav>
  <article>
    <header class="post-head">
      <h1>${esc(p.title)}</h1>
      <div class="post-meta"><time datetime="${p.date}">${fmtDate(p.date)}</time>${rating ? " &middot; " + rating : ""}${tags ? " &middot; " + tags : ""}</div>
    </header>
    <div class="prose">
${p.html}
    </div>
  </article>
  <footer class="post-foot"><a href="/writing/">&larr; more writing</a></footer>
</div>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
</body>
</html>
`;
};

// --- index page ---
const indexPage = () => {
  const items = posts
    .map(
      (p) => `    <li class="entry">
      <a class="entry-link" href="/writing/${p.slug}">
        <span class="entry-title">${esc(p.title)}</span>
        <time class="entry-date" datetime="${p.date}">${fmtDate(p.date)}</time>
      </a>${p.description ? `\n      <p class="entry-desc">${esc(p.description)}</p>` : ""}
    </li>`
    )
    .join("\n");
  return `${head({ title: `Writing · ${AUTHOR}`, desc: "Essays and notes by Christoph Rippel.", url: `${SITE}/writing/` })}
<body>
<div class="page">
  <nav class="topnav"><a href="/">&larr; rupel.xyz</a></nav>
  <header class="writing-head">
    <h1>Writing</h1>
    <p class="writing-sub">Things I saw that were new and exciting. <a href="/feed.xml">RSS</a></p>
  </header>
  <ul class="entries">
${items}
  </ul>
</div>
</body>
</html>
`;
};

// --- RSS feed ---
const feed = () => {
  const items = posts
    .map(
      (p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${SITE}/writing/${p.slug}</link>
    <guid>${SITE}/writing/${p.slug}</guid>
    ${p.date ? `<pubDate>${new Date(p.date + "T12:00:00Z").toUTCString()}</pubDate>` : ""}
    <description>${esc(p.description)}</description>
  </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${AUTHOR} — Writing</title>
  <link>${SITE}/writing/</link>
  <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Essays and notes by ${AUTHOR}.</description>
${items}
</channel>
</rss>
`;
};

// --- write everything ---
rmSync(OUT, { recursive: true, force: true }); // clear stale pages so deleted posts don't linger
mkdirSync(OUT, { recursive: true });
for (const p of posts) writeFileSync(join(OUT, `${p.slug}.html`), postPage(p));
writeFileSync(join(OUT, "index.html"), indexPage());
writeFileSync(join(ROOT, "feed.xml"), feed());
console.log(`Built ${posts.length} post(s) → /writing/ + index + feed.xml`);
