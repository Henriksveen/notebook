import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { isValidId } from "../paths.ts";

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

export interface RenderContext {
  entryId: string;
  attachmentIds: ReadonlySet<string>;
  htmlAttachmentIds: ReadonlySet<string>;
}

const ATTACHMENT_PREFIX = "attachment:";
const ATTACHMENT_PATH = /^\/attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;
const REPORT_VIEW_PATH = /^\/attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/view$/;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});
markdown.renderer.rules.s_open = () => "<del>";
markdown.renderer.rules.s_close = () => "</del>";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "ul",
    "ol",
    "li",
    "code",
    "pre",
    "blockquote",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "a",
    "img",
    "em",
    "strong",
    "del",
    "hr",
    "br",
  ],
  allowedAttributes: { a: ["href", "rel"], img: ["src", "alt"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: { a: transformLink, img: transformImage },
};

export function renderMarkdown(body: string, context: RenderContext): string {
  const env = {};
  const tokens = markdown.parse(body, env);
  rewriteTokens(tokens, context);
  return sanitizeHtml(
    markdown.renderer.render(tokens, markdown.options, env),
    SANITIZE_OPTIONS,
  );
}

function rewriteTokens(tokens: Token[], context: RenderContext): void {
  for (const token of tokens) {
    if (token.type === "link_open") rewriteAttr(token, "href", context);
    if (token.type === "image") rewriteAttr(token, "src", context);
    if (token.children) rewriteTokens(token.children, context);
  }
}

function rewriteAttr(
  token: Token,
  name: "href" | "src",
  context: RenderContext,
): void {
  const attr = token.attrs?.find(([key]) => key === name);
  if (!attr) return;
  const raw = String(attr[1]);
  if (!raw.startsWith(ATTACHMENT_PREFIX)) return;
  const id = raw.slice(ATTACHMENT_PREFIX.length);
  if (!isValidId(id) || !context.attachmentIds.has(id)) {
    attr[1] = "";
  } else if (!context.htmlAttachmentIds.has(id)) {
    attr[1] = `/attachments/${context.entryId}/${id}`;
  } else {
    attr[1] =
      name === "href" ? `/attachments/${context.entryId}/${id}/view` : "";
  }
}

function transformLink(
  _tagName: string,
  attribs: sanitizeHtml.Attributes,
): sanitizeHtml.Tag {
  const href = attribs.href ?? "";
  const kept: sanitizeHtml.Attributes = {};
  const protocol = protocolOf(href);
  if (ATTACHMENT_PATH.test(href) || REPORT_VIEW_PATH.test(href)) {
    kept.href = href;
  } else if (protocol === "http:" || protocol === "https:") {
    kept.href = href;
    kept.rel = "noopener noreferrer";
  } else if (protocol === "mailto:") {
    kept.href = href;
  }
  return { tagName: "a", attribs: kept };
}

function transformImage(
  _tagName: string,
  attribs: sanitizeHtml.Attributes,
): sanitizeHtml.Tag {
  const kept: sanitizeHtml.Attributes = { alt: attribs.alt ?? "" };
  if (ATTACHMENT_PATH.test(attribs.src ?? "")) kept.src = attribs.src;
  return { tagName: "img", attribs: kept };
}

function protocolOf(href: string): string | undefined {
  try {
    return new URL(href).protocol;
  } catch {
    return undefined;
  }
}
