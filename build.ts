// build.ts — tiny static blog generator for rupel.xyz
//
// Reads Obsidian-friendly Markdown from content/writing/*.md and renders:
//   - /writing/<slug>.html   one page per post (styled to match the site)
//   - /writing/index.html    the writing index
//   - /feed.xml              an RSS feed
//
// Frontmatter (YAML, exactly what Obsidian/Templater write):
//   title, published | date | created (YYYY-MM-DD, first one set wins), description, tags: [a, b], draft: true|false, slug?
//
// Run:  bun run build
//
// It's deliberately one readable file — no framework, nothing hidden.

import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import matter from "gray-matter";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

// --- ```chart blocks → a bar chart drawn in the site's own design ---
// The block is the YAML the Obsidian Charts plugin reads (type, labels, series: [{title, data}]),
// so the note shows a chart in the vault too. Here it becomes plain HTML bars styled by blog.css —
// never a screenshot of someone else's chart. `title` is ours (the plugin ignores it): the caption.
// Only what a post has needed so far: one bar series. Anything else throws rather than guessing.
const niceStep = (max: number, ticks = 3) => {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw)!;
};
const chart = (src: string) => {
  const spec = matter(`---\n${src}\n---`).data;
  const labels: string[] = (spec.labels ?? []).map(String);
  const data: number[] = (spec.series?.[0]?.data ?? []).map(Number);
  if (spec.type !== "bar" || spec.series?.length !== 1 || !labels.length || data.length !== labels.length || data.some(isNaN)) {
    throw new Error(`chart block: need type: bar, labels, and exactly one series whose data matches the labels.\n${src}`);
  }
  const max = Math.max(...data);
  const step = niceStep(max || 1);
  const top = Math.ceil(max / step) * step || step;
  const pct = (v: number) => `${((v / top) * 100).toFixed(2)}%`;
  const grid = Array.from({ length: top / step + 1 }, (_, i) => i * step)
    .map((v) => `<div class="chart-grid" style="bottom:${pct(v)}"><span>${v.toLocaleString("en")}</span></div>`)
    .join("");
  const bars = data.map((v, i) => `<span class="chart-bar" style="height:${pct(v)}" title="${esc(labels[i])}: ${v.toLocaleString("en")}"></span>`).join("");
  // Monthly labels (YYYY-MM) get one tick per January, labelled with the year; anything else
  // gets about six evenly spaced labels.
  const januaries = labels.flatMap((l, i) => (/^\d{4}-01$/.test(l) ? [i] : []));
  const every = Math.ceil(labels.length / 6);
  const ticks = (januaries.length ? januaries : labels.flatMap((_, i) => (i % every ? [] : [i])))
    .map((i) => `<span style="grid-column:${i + 1}">${esc(januaries.length ? labels[i].slice(0, 4) : labels[i])}</span>`)
    .join("");
  const peak = data.indexOf(max);
  const summary = `Bar chart, ${labels[0]} to ${labels.at(-1)}: ${data[0]} at the start, ${data.at(-1)} at the end, peak ${max} in ${labels[peak]}.`;
  return `<figure class="chart" style="--n:${labels.length}">
<div class="chart-plot" role="img" aria-label="${esc(summary)}">${grid}<div class="chart-bars">${bars}</div></div>
<div class="chart-x" aria-hidden="true">${ticks}</div>
${spec.title ? `<figcaption>${esc(String(spec.title))}</figcaption>\n` : ""}</figure>
`;
};
const fence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, ...rest) =>
  tokens[idx].info.trim() === "chart" ? chart(tokens[idx].content) : fence(tokens, idx, ...rest);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// gray-matter/js-yaml parses an unquoted `date: 2026-06-24` into a Date object — normalize to YYYY-MM-DD.
const toISODate = (d: unknown): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10);
// A post's date: when it went out (`published:`), else `date:`, else when the note was `created:`.
// An empty `published:` parses as null, so unpublished drafts fall through to `created:`.
const postDate = (data: Record<string, unknown>) => toISODate(data.published ?? data.date ?? data.created);
const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return y ? `${MONTHS[(m || 1) - 1]} ${day}, ${y}` : d;
};
const fmtMonthYear = (d: string) => {
  const [y, m] = d.split("-").map(Number);
  return y ? `${MONTHS_FULL[(m || 1) - 1]} ${y}` : d;
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
    return { slug: (data.slug as string) || basename(f, ".md"), file: f, data, content };
  })
  .filter((p) => !p.data.draft)
  // Sort newest-first on a normalized ISO key. NB: js-yaml parses unquoted dates
  // into Date objects, and String(Date) is "Wed Jun 24 2026 …" — which localeCompare would sort
  // by weekday name, not chronologically. toISODate() collapses both to "YYYY-MM-DD" first.
  .sort((a, b) => postDate(b.data).localeCompare(postDate(a.data)));

// --- slug collisions ---
// Renaming a note in Obsidian creates a new file; the old one keeps its `slug:` and its
// `share: true` unless you delete it. Two files then claim one URL: both get listed on the
// index and in the feed, both land in the sitemap, and whichever readdir() happens to return
// last silently overwrites the page — which is how a stale title survives a rename. Refuse to
// build instead, and name both files so the fix is obvious.
const bySlug = new Map<string, string[]>();
for (const p of loaded) {
  const list = bySlug.get(p.slug) ?? [];
  list.push(p.file);
  bySlug.set(p.slug, list);
}
const collisions = [...bySlug].filter(([, files]) => files.length > 1);
if (collisions.length) {
  const detail = collisions
    .map(([slug, files]) => `  slug "${slug}" claimed by:\n${files.map((f) => `    - content/writing/${f}`).join("\n")}`)
    .join("\n");
  throw new Error(
    `Duplicate slugs — each would overwrite the other's page:\n${detail}\n` +
      `Delete the stale note in Obsidian, or set 'draft: true' / change its 'slug:'.`
  );
}

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

// --- ![[image.png]] embeds → <img> served from /writing/media/ ---
// Enveloppe pushes a note's attachments next to it in content/writing/, which is never served
// (.assetsignore). Only images a published post embeds get copied out; the rest stays private.
// `|alt text|300` → alt + width, like Obsidian: a trailing `|300` or `|300x200` is the width, the
// rest is alt text, unless Enveloppe merely repeated the file name there. Embedded notes or PDFs
// fall through to resolveWikilinks as plain links.
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const media = new Set<string>();
const resolveEmbeds = (text: string, file: string) =>
  text.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, target, label) => {
    const name = basename(String(target).trim());
    if (!IMAGE.test(name)) return m.slice(1);
    if (!existsSync(join(SRC, name))) {
      throw new Error(`content/writing/${file} embeds "${name}", which isn't in content/writing/ — did Enveloppe push the attachment?`);
    }
    media.add(name);
    const parts = String(label ?? "").split("|").map((s) => s.trim());
    const width = /^\d+(x\d+)?$/.test(parts.at(-1) ?? "") ? parts.pop()!.split("x")[0] : "";
    const shown = parts.join("|");
    const alt = shown === name ? "" : shown;
    return `<img src="/writing/media/${encodeURI(name)}" alt="${esc(alt)}"${width ? ` width="${width}"` : ""} loading="lazy">`;
  });

const posts: Post[] = loaded.map((p) => ({
  slug: p.slug,
  title: String(p.data.title || p.slug),
  date: postDate(p.data),
  description: String(p.data.description || ""),
  tags: Array.isArray(p.data.tags) ? p.data.tags.map(String) : [],
  rating: p.data.rating != null && p.data.rating !== "" ? Number(p.data.rating) : null,
  html: md.render(resolveWikilinks(resolveEmbeds(p.content, p.file))),
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

// --- site nav ---
// The same nav on every inner page of rupel.xyz, in this order. The rupelxyz-music repo builds
// the identical markup for its pages (vite.config.ts), so change both together. aria-current
// marks the section you're in: "page" on the section's own index, "true" on pages inside it.
const nav = (writing?: "page" | "true") =>
  `<nav class="topnav"><a href="/">&larr; rupel.xyz</a><a href="/writing/"${writing ? ` aria-current="${writing}"` : ""}>writing</a><a href="/music/">music</a></nav>`;

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
  ${nav("true")}
  <article>
    <header class="post-head">
      <h1>${esc(p.title)}</h1>
      <div class="post-meta"><time datetime="${p.date}">${fmtDate(p.date)}</time>${rating ? " &middot; " + rating : ""}${tags ? " &middot; " + tags : ""}</div>
    </header>
    <div class="prose">
${p.html}
    </div>
  </article>
  <footer class="post-foot"><a href="/writing/">&larr; all writing</a></footer>
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
  ${nav("page")}
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

// --- sitemap ---
// Hand-maintained sitemaps rot: they list the homepage and forget every post.
// Generate it here so it always covers home + the writing index + every published post.
//
// Hand-written project pages (singify/index.html etc.) aren't generated from content/, so they'd
// be invisible to the sitemap otherwise. List them here; `lastmod` comes from the file's mtime so
// it stays honest without anyone having to remember to bump a date.
const PROJECT_PAGES = ["cstheskin"];

// Pages served under rupel.xyz paths by their own Cloudflare workers: the game (cstheskin
// repo) and everything under /music/ (music repo). No file exists here for them, but they're
// rupel.xyz URLs, so this sitemap is the only one that can list them — a sitemap under a
// subpath isn't fetched, and neither is a robots.txt. Both live at the root; see robots.txt
// for the matching /api/ disallow.
const APP_PAGES = [
  "guesstheskin/",
  "music/",
  "music/modes/",
  "music/songmap/",
  "music/tubs/",
  "music/singify/",
];

const sitemap = () => {
  const today = new Date().toISOString().slice(0, 10);
  const newest = posts[0]?.date || today; // posts are sorted newest-first
  const projects = PROJECT_PAGES.flatMap((slug) => {
    const file = join(ROOT, slug, "index.html");
    if (!existsSync(file)) {
      console.warn(`! Sitemap: PROJECT_PAGES lists "${slug}" but ${file} is missing — skipping.`);
      return [];
    }
    return [{ loc: `${SITE}/${slug}/`, lastmod: statSync(file).mtime.toISOString().slice(0, 10), changefreq: "monthly", priority: "0.8" }];
  });
  const urls = [
    { loc: `${SITE}/`, lastmod: today, changefreq: "weekly", priority: "1.0" },
    { loc: `${SITE}/writing/`, lastmod: newest, changefreq: "weekly", priority: "0.8" },
    ...projects,
    ...APP_PAGES.map((path) => ({ loc: `${SITE}/${path}`, lastmod: today, changefreq: "monthly", priority: "0.8" })),
    ...posts.map((p) => ({ loc: `${SITE}/writing/${p.slug}`, lastmod: p.date || today, changefreq: "monthly", priority: "0.6" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`)
  .join("\n")}
</urlset>
`;
};

// --- homepage "last updated" stamp ---
// A stale masthead date is worse than none, and so is a typed one. It's the date of the commit
// being built: every change to the site is a commit (posts arrive as Enveloppe's merges), and
// Cloudflare runs this build on every deploy, so the live date moves with the site. Outside a git
// checkout it falls back to the newest post. Rewrites one marked element in index.html in place;
// a missing marker throws rather than skipping.
const lastCommitDate = (): string | undefined => {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
};

const stampHomepage = () => {
  const file = join(ROOT, "index.html");
  const commit = lastCommitDate();
  const newest = commit ?? posts[0]?.date; // posts are sorted newest-first
  if (!newest) {
    console.warn("! No git history and no published posts — leaving the homepage date alone.");
    return;
  }
  const html = readFileSync(file, "utf8");
  const marker = /<time class="masthead-updated"[^>]*>[^<]*<\/time>/;
  if (!marker.test(html)) {
    throw new Error('index.html: missing <time class="masthead-updated"> — the homepage date can no longer be stamped.');
  }
  const stamped = html.replace(marker, `<time class="masthead-updated" datetime="${newest}">${fmtMonthYear(newest)}</time>`);
  if (stamped !== html) {
    writeFileSync(file, stamped);
    console.log(`Homepage date → ${fmtMonthYear(newest)} (${commit ? "last commit" : "newest post"}: ${newest})`);
  }
};

// --- write everything ---
rmSync(OUT, { recursive: true, force: true }); // clear stale pages so deleted posts don't linger
mkdirSync(OUT, { recursive: true });
for (const p of posts) writeFileSync(join(OUT, `${p.slug}.html`), postPage(p));
if (media.size) mkdirSync(join(OUT, "media"));
for (const name of media) copyFileSync(join(SRC, name), join(OUT, "media", name));
writeFileSync(join(OUT, "index.html"), indexPage());
writeFileSync(join(ROOT, "feed.xml"), feed());
writeFileSync(join(ROOT, "sitemap.xml"), sitemap());
stampHomepage();
console.log(`Built ${posts.length} post(s) → /writing/ + index + feed.xml + sitemap.xml`);
