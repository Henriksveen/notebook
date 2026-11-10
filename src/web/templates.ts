const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export function layout(
  title: string,
  content: string,
  searchTarget = "/pages",
): string {
  const searchLabel =
    searchTarget === "/prompts" ? "Search prompts" : "Search pages";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Notebook</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="site-header">
<a class="brand" href="/">Notebook</a>
<nav aria-label="Main">
<a href="/">Pages</a>
<a href="/prompts">Prompts</a>
</nav>
${
  searchTarget
    ? `<form class="search" action="${searchTarget}" method="get" role="search">
<input type="search" name="q" aria-label="${searchLabel}" placeholder="${searchLabel}">
<button type="submit">Search</button>
</form>`
    : ""
}
</header>
<main>
${content}
</main>
<footer class="site-footer">Read-only local view. Not authenticated; reachable only from this machine.</footer>
</body>
</html>
`;
}

export function notFoundPage(): string {
  return layout(
    "Not found",
    "<h1>Not found</h1><p>This page is not available.</p>",
  );
}
export function errorPage(): string {
  return layout(
    "Unavailable",
    "<h1>Temporarily unavailable</h1><p>Try again shortly.</p>",
  );
}
