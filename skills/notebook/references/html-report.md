# HTML narrative reports

Use this for findings, research, decisions, incident write-ups, and summaries. Read
`html-style.md` first; this guide only adds structure.

## Page structure

1. **Header** (`.header`): `.eyebrow` with project and report type, an `h1` that states the
   subject specifically, and a `.lede` with the main takeaway in one or two sentences.
2. **Key points** (optional): a `.grid` of up to four `.card`s, or a short list, with the
   conclusions a reader needs if they read nothing else.
3. **Sections**: each `section.section` has an `h2` and content inside `.prose`. Typical order:
   Context, Findings, Evidence, Caveats, Next steps. Use the order that fits the content.
4. **Footer**: a small `.muted` paragraph with the data source, method, and generation date.

```html
<section class="section prose">
  <h2>Findings</h2>
  <p>Requests time out after 60 s when the connection pool is saturated.</p>
  <div class="callout warning">
    <p><strong>Assumption:</strong> the pool limit is the same in staging and production.</p>
  </div>
</section>
```

## Writing

- Lead with conclusions, then evidence. Each section starts with its point.
- Short paragraphs (two to four sentences) and lists for parallel items.
- Keep exact specifics: numbers with units, versions, commands, file paths, error messages.
- Label speculation. Use `.callout.warning` with "Assumption:" or "Unverified:" for anything
  not observed directly. Use `.callout.error` only for problems and `.callout.success` only for
  confirmed results.
- Status words get badges: `<span class="badge success">fixed</span>`,
  `<span class="badge warning">open</span>`, `<span class="badge error">high</span>`.
- Quote sources with `blockquote` and cite them in the footer. External links are allowed as
  plain `<a href>` text; nothing may be loaded from them.

## Optional interaction

Narrative pages rarely need JavaScript. Acceptable enhancements:

- A table of contents in a `.card` with in-page `#anchor` links.
- `<details>` and `<summary>` for long evidence blocks (no script needed). Style the summary
  with `cursor: pointer` and `font-weight: 500`.
- Code: show commands in `pre`. Do not add copy-to-clipboard buttons; the sandbox can block
  clipboard access.
