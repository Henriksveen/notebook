# HTML report style: T3 Code dark

Read this before writing any notebook HTML report. The goal is a calm, readable page that looks
like T3 Code in dark mode: black canvas, near-white text, quiet borders, one blue accent.

## Start from the base stylesheet

Copy all of `t3-dark.css` (next to this file) into the report's `<style>` element, unchanged.
Add page-specific rules after it, and build them from its variables. Never introduce a new
color, font, or radius that is not derived from a variable.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Specific report title</title>
<style>
/* contents of t3-dark.css */
/* page-specific rules */
</style>
</head>
<body>
<main class="page">
  <header class="header">
    <p class="eyebrow">Project · Report type</p>
    <h1>Specific report title</h1>
    <p class="lede">One or two sentences: what this page shows and the main takeaway.</p>
  </header>
  <!-- sections -->
</main>
<script>
// optional inline JavaScript
</script>
</body>
</html>
```

## Tokens

| Purpose | Variable | Value |
| --- | --- | --- |
| Page background | `--background` | `#000000` |
| Cards, tables, raised panels | `--surface` | `#111111` |
| Nested or selected surface | `--surface-2` | `#1e1e1e` |
| Body text | `--foreground` | `#f5f5f5` |
| Secondary text, labels, axes | `--muted-foreground` | `#a1a1a1` |
| Borders and dividers | `--border` | white at 8% |
| Input and button borders | `--input` | white at 11% |
| Subtle fill, hover | `--muted`, `--accent`, `--hover` | white at 3%, 4%, 6% |
| Primary action, focus, selected | `--primary` | `#346bf1` |
| Links | `--link` | `#51a2ff` |
| Status | `--info`, `--success`, `--warning`, `--error` | `#51a2ff`, `#00d492`, `#ffb900`, `#ff6467` |
| Status fills | `--info-surface` and siblings | status color at 12% |
| Chart series, in order | `--chart-1` … `--chart-7` | blue, green, amber, violet, sky, pink, orange |

Typography: system UI font stack (`--font-sans`), 15 px body, line height 1.6. Headings are
semibold (600), never bold black: h1 1.5rem, h2 1.125rem, h3 1rem. Numbers in tables, KPIs, and
charts use `font-variant-numeric: tabular-nums` (`.num`). Code uses `--font-mono`.

## Ready-made classes

- Layout: `.page` (centered, max 72rem), `.prose` (max 46rem reading width), `.header`,
  `.section`, `.stack`, `.grid` (responsive columns), `.row` (inline flex with wrap).
- Text: `.eyebrow`, `.lede`, `.muted`, `.num`.
- Surfaces: `.card`, `.card-title`.
- KPIs: `.stat-label`, `.stat-value`, `.stat-delta` with `.up` or `.down`.
- Callouts: `.callout` plus `.info`, `.success`, `.warning`, or `.error`.
- Badges: `.badge` plus an optional status class.
- Tables: wrap in `.table-wrap`; numeric columns get `.num`.
- Controls: `button`, `button.primary`, `button[aria-pressed="true"]`, `input`, `select`.

## Rules

- Readability first: long text stays inside `.prose`; never put body text below 0.8125rem
  (13 px); keep secondary text in `--muted-foreground`, not darker.
- Contrast: never put gray text on a colored fill; status colors are for small accents, badges,
  deltas, and chart marks, not for paragraphs.
- Restraint: no gradients, glows, drop shadows, glassmorphism, emoji headings, or decorative
  icons. Use spacing and thin borders to separate content. One `.card` level only; do not nest
  cards inside cards.
- Accent: `--primary` marks the single most important action or selection. Do not color
  headings or large areas with it.
- Motion: none by default. Hover changes are instant background changes.
- Light mode: do not add one. The report is always dark.
- Accessibility: real `<button>` elements for interactions, `aria-pressed` for toggles,
  visible focus (already in the base stylesheet), a `<caption>` or heading for every table and
  chart, and color is never the only signal (pair it with a label, sign, or icon-free text).

## Sandbox constraints (the report must work under these)

The notebook serves reports in a sandboxed frame with a strict Content Security Policy:

- Everything inline: one `.html` file with inline `<style>` and `<script>`. No external or
  relative URLs for scripts, stylesheets, images, fonts, or frames.
- Images only as inline `<svg>` or `data:` URLs; fonts only as the system stack above.
- No `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, workers, or nested iframes.
- No `eval`, `new Function`, string `setTimeout`, or libraries that need them. Write charts
  by hand with inline SVG (see `html-data.md`); do not paste charting libraries.
- No `localStorage`, `sessionStorage`, cookies, or IndexedDB (they throw in the sandbox).
- No forms that submit, `alert`/`confirm`/`prompt`, popups, or navigation.
- The page must make sense with JavaScript disabled for its first view: render the main
  content as HTML and use scripts only to enhance it (sorting, filtering, toggles, tooltips).

## Choose the companion guide

- Narrative content (findings, analysis, decisions, summaries): read `html-report.md`.
- Numbers (tables, charts, KPIs, comparisons, filtering, sorting): read `html-data.md`.
- Both kinds of content: read both.
