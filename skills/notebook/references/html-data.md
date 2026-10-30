# HTML data views

Use this for KPIs, tables, charts, comparisons, and pages with filtering or sorting. Read
`html-style.md` first; this guide adds data patterns.

## Data first

- Embed the data once, as a JSON literal in a `<script>` element, and build every view from it:
  `<script id="data" type="application/json">[...]</script>`, read with
  `JSON.parse(document.getElementById("data").textContent)`.
- Render the first view as static HTML too (table rows, SVG marks), so the page is useful
  before any script runs. Scripts then re-render from the JSON for sorting and filtering.
- Format numbers consistently with `Intl.NumberFormat("en-US", ...)`. State units in column
  headers or axis titles, not in every cell.

## Page structure

1. `.header` with the takeaway in the `.lede` ("Checkout latency fell 18% after the cache fix").
2. KPI row: `.grid` of up to four `.card`s with `.stat-label`, `.stat-value`, and an optional
   `.stat-delta.up` or `.stat-delta.down` (include the sign and the comparison period).
3. Main chart in a `.card` with a `.card-title` and a one-line `.muted` caption.
4. Detail table in `.table-wrap`, with controls above it in a `.row`.
5. Footer `.muted` paragraph: source, date range, and method.

## Charts: inline SVG, by hand

No chart libraries. Draw with `<svg viewBox="0 0 W H" role="img" aria-labelledby="...">` and
let it scale with `width: 100%; height: auto`.

- Size the `viewBox` to the width the chart will actually render at (about 1100 for a
  full-width card, 520 for a half-width card). SVG text scales with the viewBox, so a 640-wide
  viewBox in a 1100 px card turns 12 px labels into 20 px labels. Keep labels at 12–13 units.
- Series colors in order: `var(--chart-1)` to `var(--chart-7)`. Use one color when there is one
  series. Use `--success` and `--error` only when the meaning is good or bad.
- Gridlines: only across the value axis (horizontal for column and line charts, vertical for
  horizontal bar charts), `stroke: var(--chart-grid)`, 1 px. No chart border, no background
  fill.
- Axis labels: `fill: var(--chart-axis)`, 12 px, tabular numbers. Start bar and area axes at
  zero. Use round tick values (for example 0, 25, 50, 75, 100).
- Bars: 2–4 px corner radius at the top, gaps of about 30% of the bar width.
- Lines: 2 px stroke, `stroke-linejoin: round`, no fill below unless it is an area chart with
  12% opacity. Mark only the last point or highlighted points with a 3 px circle.
- Label directly where possible (series name at the line end, value above a bar) instead of a
  legend. If a legend is needed, put it above the chart as a `.row` of small swatches.
- Tooltips: an absolutely positioned `div` styled like a `.card` with `font-size: 0.8125rem`,
  shown on `pointermove` and hidden on `pointerleave`. Keyboard users get the same values from
  the table.
- Pick the chart for the question: bar for comparing categories, line for change over time,
  stacked bar only for parts of a whole with at most five parts. No pie charts, no 3D, no dual
  axes.

```html
<div class="card">
  <p class="card-title" id="lat-title">p95 latency by week (ms)</p>
  <svg viewBox="0 0 1100 240" role="img" aria-labelledby="lat-title" style="width:100%;height:auto">
    <g stroke="var(--chart-grid)">
      <line x1="40" x2="1090" y1="20" y2="20"/><line x1="40" x2="1090" y1="120" y2="120"/>
      <line x1="40" x2="1090" y1="220" y2="220"/>
    </g>
    <g fill="var(--chart-axis)" font-size="12" text-anchor="end">
      <text x="32" y="24">400</text><text x="32" y="124">200</text><text x="32" y="224">0</text>
    </g>
    <polyline fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linejoin="round"
      points="40,80 250,95 460,110 670,150 880,160 1090,165"/>
    <circle cx="1090" cy="165" r="3" fill="var(--chart-1)"/>
  </svg>
</div>
```

## Tables

- Wrap in `.table-wrap`. Numeric columns get `class="num"` on both `th` and `td`.
- Sortable columns: put a `<button>` inside the `th` (inherit font, no border, no background,
  `color: inherit`, full width), set `aria-sort="ascending"` or `"descending"` on the active
  `th`, and show a small ▲ or ▼ after the label. Sorting never changes the data, only the order.
- Filters: a `.row` above the table with a search `input` (filters on text columns as you type)
  and toggle buttons using `aria-pressed`. Show the result count in a `.muted` span, for example
  "12 of 48 rows".
- Status columns use `.badge` with a status class. Empty values show `—` in `.muted`.
- Long tables: show the first 50 rows and a "Show all" button rather than paginating.

## Interaction rules

- Every control works with the keyboard and has a visible label.
- Keep state in memory only (no storage APIs, no URL changes).
- Update the visible count, chart, and table together after any filter change.
- Use event delegation and plain DOM APIs; no frameworks.
