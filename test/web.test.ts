import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { entryUrl } from "../src/config.ts";
import { sha256Hex } from "../src/revision.ts";
import type { Attachment } from "../src/schema.ts";
import { openNotebook } from "../src/web/open.ts";
import { createServer, type WebServer } from "../src/web/server.ts";
import {
  cleanupTempDirs,
  freePort,
  ID_1,
  ID_2,
  ID_3,
  makeEntry,
  makeTempDir,
  newNotebook,
  writeEntryFile,
} from "./fixtures.ts";

after(cleanupTempDirs);

const ATT_PNG = "11111111-2222-4333-8444-555555555555";
const ATT_HTML = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const ATT_SVG = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const ATT_PDF = "12345678-1234-4234-8234-123456789abc";
const UNLISTED = "00000000-0000-4000-8000-000000000001";
const ARCHIVED = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const BROKEN = "12345678-9abc-4def-8123-456789abcdef";
const MISSING = "00000000-0000-4000-8000-000000000999";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: { Host: options.host ?? `127.0.0.1:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function assertSecurityHeaders(reply: Reply): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(reply.headers[name], value, `${name} header`);
  }
}

function attachmentRecord(
  id: string,
  filename: string,
  storedAs: string,
  mediaType: string,
  bytes: Buffer,
): Attachment {
  return {
    id,
    filename,
    stored_as: storedAs,
    media_type: mediaType,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

async function writeAttachment(
  dir: string,
  entryId: string,
  storedAs: string,
  bytes: Buffer,
): Promise<void> {
  await mkdir(join(dir, "attachments", entryId), { recursive: true });
  await writeFile(join(dir, "attachments", entryId, storedAs), bytes);
}

const TEXT_BYTES = Buffer.from("<html><script>alert(1)</script></html>");
const SVG_BYTES = Buffer.from("<svg onload='alert(1)'></svg>");
const PDF_BYTES = Buffer.from("%PDF-1.4 fake");

async function fixtureNotebook(): Promise<string> {
  const dir = await makeTempDir();
  await writeEntryFile(
    dir,
    makeEntry({
      id: ID_1,
      title: "Alpha <script>alert(1)</script> note",
      summary: "Summary with <b>tags</b>",
      project: "Research",
      topics: ["architecture", "rust-lang"],
      type: "research",
      updated_at: "2026-10-28T12:00:00.000Z",
      created_at: "2026-10-27T12:00:00.000Z",
      sources: [
        {
          kind: "url",
          url: "https://example.com/source",
          title: "Source page",
        },
        {
          kind: "repo",
          repo: "github.com/a/b",
          commit: "abc123",
          path: "src/x.ts",
        },
        { kind: "conversation", ref: "thread-42", title: "Chat" },
      ],
      attachments: [
        attachmentRecord(
          ATT_PNG,
          "photo.png",
          `${ATT_PNG}.png`,
          "image/png",
          PNG_BYTES,
        ),
        attachmentRecord(
          ATT_HTML,
          "page.html",
          `${ATT_HTML}.html`,
          "text/html",
          TEXT_BYTES,
        ),
        attachmentRecord(
          ATT_SVG,
          "diagram.svg",
          `${ATT_SVG}.svg`,
          "image/svg+xml",
          SVG_BYTES,
        ),
        attachmentRecord(
          ATT_PDF,
          "rapport é.pdf",
          `${ATT_PDF}.pdf`,
          "application/pdf",
          PDF_BYTES,
        ),
      ],
    }),
    [
      'Intro with <script>alert("x")</script> raw.',
      "",
      `![diagram](attachment:${ATT_PNG})`,
      "",
      `[report](attachment:${ATT_HTML}) and [remote](https://example.com/page)`,
      "",
      "![tracker](https://tracker.example/pixel.png)",
      "",
      "[bad](javascript:alert(1))",
      "",
      "Unknown: ![nope](attachment:00000000-0000-4000-8000-000000000009)",
      "",
    ].join("\n"),
  );
  await writeAttachment(dir, ID_1, `${ATT_PNG}.png`, PNG_BYTES);
  await writeAttachment(dir, ID_1, `${ATT_HTML}.html`, TEXT_BYTES);
  await writeAttachment(dir, ID_1, `${ATT_SVG}.svg`, SVG_BYTES);
  await writeAttachment(dir, ID_1, `${ATT_PDF}.pdf`, PDF_BYTES);
  await writeAttachment(dir, ID_1, `${UNLISTED}.txt`, Buffer.from("secret"));
  await writeEntryFile(
    dir,
    makeEntry({
      id: ID_2,
      title: "Beta idea",
      summary: "Second summary",
      project: "Labs <script>x</script>",
      topics: ["architecture"],
      type: "idea",
      status: "ready",
      updated_at: "2026-10-29T12:00:00.000Z",
      created_at: "2026-10-29T12:00:00.000Z",
    }),
    "Beta body with the word idea.\n",
  );
  await writeEntryFile(
    dir,
    makeEntry({
      id: ARCHIVED,
      title: "Gamma archived",
      summary: "Archived summary",
      project: "Research",
      topics: ["archive-only"],
      type: "research",
      status: "archived",
      archived_from: "draft",
      updated_at: "2026-10-27T10:00:00.000Z",
      created_at: "2026-10-27T10:00:00.000Z",
    }),
    "Gamma body text.\n",
  );
  return dir;
}

describe("website", () => {
  let dir: string;
  let server: WebServer;

  before(async () => {
    dir = await fixtureNotebook();
    server = await createServer({ dir, port: 0 });
  });

  after(async () => {
    await server.close();
  });

  describe("security", () => {
    it("sends the security headers on every kind of response", async () => {
      const replies = await Promise.all([
        request(server.port, "/"),
        request(server.port, "/static/style.css"),
        request(server.port, "/_health"),
        request(server.port, `/attachments/${ID_1}/${ATT_PNG}`),
        request(server.port, "/entries/missing"),
        request(server.port, "/", { host: "evil.example" }),
        request(server.port, "/", { method: "POST" }),
      ]);
      for (const reply of replies) assertSecurityHeaders(reply);
      assert.deepEqual(
        replies.map((reply) => reply.status),
        [200, 200, 200, 200, 404, 421, 405],
      );
    });

    it("rejects foreign Host headers with 421", async () => {
      assert.equal(
        (await request(server.port, "/", { host: "evil.example" })).status,
        421,
      );
      assert.equal(
        (await request(server.port, "/", { host: `127.0.0.1` })).status,
        421,
      );
      assert.equal(
        (await request(server.port, "/", { host: `127.0.0.2:${server.port}` }))
          .status,
        421,
      );
    });

    it("accepts localhost with the server port", async () => {
      const reply = await request(server.port, "/_health", {
        host: `localhost:${server.port}`,
      });
      assert.equal(reply.status, 200);
    });

    it("answers other methods with 405 and an Allow header", async () => {
      const reply = await request(server.port, "/", { method: "POST" });
      assert.equal(reply.status, 405);
      assert.equal(reply.headers.allow, "GET, HEAD");
      assert.equal(
        (await request(server.port, "/", { method: "DELETE" })).status,
        405,
      );
    });

    it("answers HEAD without a body", async () => {
      const reply = await request(server.port, "/", { method: "HEAD" });
      assert.equal(reply.status, 200);
      assert.equal(reply.body, "");
      assert.ok(Number(reply.headers["content-length"]) > 0);
    });

    it("answers unknown routes with a 404 page", async () => {
      const reply = await request(server.port, "/nope");
      assert.equal(reply.status, 404);
      assert.ok(reply.body.includes("Not found"));
    });

    it("answers with a generic 500 page when an entry is broken", async () => {
      await writeFile(
        join(dir, "entries", `${BROKEN}.md`),
        "---\nnot: [valid\n---\nbody\n",
      );
      const reply = await request(server.port, `/entries/${BROKEN}`);
      assert.equal(reply.status, 500);
      assertSecurityHeaders(reply);
      assert.equal(reply.body.includes("front matter"), false);
      assert.equal(reply.body.includes("invalid"), false);
    });

    it("refuses entry files that are symbolic links", async () => {
      const target = join(await makeTempDir(), "outside.md");
      await writeFile(target, "outside");
      await symlink(target, join(dir, "entries", `${ID_3}.md`));
      assert.equal(
        (await request(server.port, `/entries/${ID_3}`)).status,
        404,
      );
    });
  });

  describe("pages", () => {
    it("lists recent non-archived entries on the home page", async () => {
      const reply = await request(server.port, "/");
      assert.equal(reply.status, 200);
      assert.ok(reply.body.includes("Beta idea"));
      assert.ok(
        reply.body.includes("Alpha &lt;script&gt;alert(1)&lt;/script&gt; note"),
      );
      assert.equal(reply.body.includes("Gamma archived"), false);
      assert.equal(reply.body.includes("<script>alert(1)</script>"), false);
      assert.ok(reply.body.indexOf("Beta idea") < reply.body.indexOf("Alpha"));
    });

    it("escapes project and summary metadata", async () => {
      const reply = await request(server.port, "/projects");
      assert.ok(
        reply.body.includes(
          'href="/projects/Labs%20%3Cscript%3Ex%3C%2Fscript%3E">Labs &lt;script&gt;x&lt;/script&gt;</a>',
        ),
      );
      assert.equal(reply.body.includes("<script>x</script>"), false);
      const home = await request(server.port, "/");
      assert.ok(home.body.includes("Summary with &lt;b&gt;tags&lt;/b&gt;"));
    });

    it("renders an entry with metadata, body, sources and attachments", async () => {
      const reply = await request(server.port, `/entries/${ID_1}`);
      assert.equal(reply.status, 200);
      assertSecurityHeaders(reply);
      assert.ok(
        reply.body.includes(
          "<h1>Alpha &lt;script&gt;alert(1)&lt;/script&gt; note</h1>",
        ),
      );
      assert.ok(reply.body.includes('href="/projects/Research"'));
      assert.ok(reply.body.includes('href="/topics/architecture"'));
      assert.ok(reply.body.includes('href="/topics/rust-lang"'));
      assert.ok(
        reply.body.includes('<span class="badge badge-draft">draft</span>'),
      );
      assert.ok(reply.body.includes("Intro with &lt;script&gt;"));
      assert.ok(reply.body.includes(`src="/attachments/${ID_1}/${ATT_PNG}"`));
      assert.ok(reply.body.includes(`href="/attachments/${ID_1}/${ATT_HTML}"`));
      assert.ok(reply.body.includes('href="https://example.com/source"'));
      assert.ok(reply.body.includes("github.com/a/b"));
      assert.ok(reply.body.includes("Conversation: thread-42"));
      assert.ok(reply.body.includes("rapport é.pdf"));
      assert.equal(reply.body.includes("tracker.example"), false);
      assert.equal(reply.body.includes('href="javascript'), false);
      assert.equal(reply.body.includes("<script>alert"), false);
      assert.equal(reply.body.includes("Archived"), false);
    });

    it("shows a banner on archived entries reached by id", async () => {
      const reply = await request(server.port, `/entries/${ARCHIVED}`);
      assert.equal(reply.status, 200);
      assert.ok(reply.body.includes('class="banner"'));
      assert.ok(reply.body.includes("Archived"));
      assert.ok(reply.body.includes("Gamma body text."));
    });

    it("404s on malformed and unknown entry ids", async () => {
      assert.equal(
        (await request(server.port, "/entries/not-a-uuid")).status,
        404,
      );
      assert.equal(
        (await request(server.port, `/entries/${MISSING}`)).status,
        404,
      );
      assert.equal(
        (await request(server.port, "/entries/..%2F..%2Fetc")).status,
        404,
      );
    });

    it("reads entries from disk on every request", async () => {
      const path = join(dir, "entries", `${ID_2}.md`);
      const before = await readFile(path, "utf8");
      await writeFile(path, before.replace("Beta idea", "Beta renamed"));
      try {
        assert.ok(
          (await request(server.port, `/entries/${ID_2}`)).body.includes(
            "Beta renamed",
          ),
        );
      } finally {
        await writeFile(path, before);
      }
    });

    it("lists projects with counts and excludes archived entries", async () => {
      const reply = await request(server.port, "/projects");
      assert.ok(
        reply.body.includes(
          'href="/projects/Research">Research</a> <span class="count">1</span>',
        ),
      );
      assert.ok(reply.body.includes('<span class="count">1</span>'));
    });

    it("lists a project's entries and handles odd names", async () => {
      const research = await request(server.port, "/projects/Research");
      assert.ok(research.body.includes("Alpha"));
      assert.equal(research.body.includes("Gamma archived"), false);
      const labs = await request(
        server.port,
        "/projects/Labs%20%3Cscript%3Ex%3C%2Fscript%3E",
      );
      assert.ok(labs.body.includes("Beta idea"));
      assert.equal(
        (await request(server.port, "/projects/%E0%A4%A")).status,
        404,
      );
      assert.equal((await request(server.port, "/projects/a/b")).status, 404);
    });

    it("lists topics with counts", async () => {
      const reply = await request(server.port, "/topics");
      assert.ok(
        reply.body.includes(
          'href="/topics/architecture">architecture</a> <span class="count">2</span>',
        ),
      );
      assert.ok(
        reply.body.includes(
          'href="/topics/rust-lang">rust-lang</a> <span class="count">1</span>',
        ),
      );
      assert.equal(reply.body.includes("archive-only"), false);
    });

    it("lists a topic's entries", async () => {
      const reply = await request(server.port, "/topics/architecture");
      assert.ok(reply.body.includes("Alpha"));
      assert.ok(reply.body.includes("Beta idea"));
      assert.equal(reply.body.includes("Gamma archived"), false);
    });

    it("serves the stylesheet as CSS", async () => {
      const reply = await request(server.port, "/static/style.css");
      assert.equal(reply.status, 200);
      assert.equal(reply.headers["content-type"], "text/css; charset=utf-8");
      assert.ok(reply.body.includes("prefers-color-scheme"));
      assert.equal(
        (await request(server.port, "/static/other.css")).status,
        404,
      );
    });

    it("reports the fingerprint of the canonical data directory", async () => {
      const reply = await request(server.port, "/_health");
      assert.equal(
        reply.headers["content-type"],
        "application/json; charset=utf-8",
      );
      const expected = createHash("sha256")
        .update(await realpath(dir))
        .digest("hex");
      assert.deepEqual(JSON.parse(reply.body), {
        app: "notebook",
        api_version: 1,
        fingerprint: expected,
      });
    });
  });

  describe("search", () => {
    const titles = (body: string) =>
      ["Alpha", "Beta idea", "Gamma archived"].filter((title) =>
        body.includes(title),
      );

    it("matches query terms against title, summary and body", async () => {
      assert.deepEqual(
        titles((await request(server.port, "/search?q=alpha")).body),
        ["Alpha"],
      );
      assert.deepEqual(
        titles((await request(server.port, "/search?q=body+idea")).body),
        ["Beta idea"],
      );
    });

    it("filters by project, topic and type", async () => {
      const reply = await request(
        server.port,
        "/search?project=research&topic=architecture",
      );
      assert.deepEqual(titles(reply.body), ["Alpha"]);
      assert.deepEqual(
        titles((await request(server.port, "/search?type=idea")).body),
        ["Beta idea"],
      );
      assert.deepEqual(
        titles((await request(server.port, "/search?status=ready")).body),
        ["Beta idea"],
      );
    });

    it("hides archived entries unless asked", async () => {
      assert.deepEqual(
        titles((await request(server.port, "/search?q=gamma")).body),
        [],
      );
      assert.ok(
        (
          await request(server.port, "/search?q=gamma&include_archived=1")
        ).body.includes("Gamma archived"),
      );
      assert.ok(
        (await request(server.port, "/search?status=archived")).body.includes(
          "Gamma archived",
        ),
      );
    });

    it("treats empty filter fields as unset", async () => {
      const reply = await request(
        server.port,
        "/search?q=&project=&topic=&type=&status=",
      );
      assert.deepEqual(titles(reply.body), ["Alpha", "Beta idea"]);
    });

    it("escapes the query when echoing it back", async () => {
      const reply = await request(server.port, "/search?q=%3Cscript%3E");
      assert.ok(reply.body.includes('value="&lt;script&gt;"'));
      assert.equal(reply.body.includes('value="<script>"'), false);
    });
  });

  describe("attachments", () => {
    it("serves raster images inline with their media type", async () => {
      const reply = await request(
        server.port,
        `/attachments/${ID_1}/${ATT_PNG}`,
      );
      assert.equal(reply.status, 200);
      assert.equal(reply.headers["content-type"], "image/png");
      assert.ok(
        String(reply.headers["content-disposition"]).startsWith("inline"),
      );
      assert.equal(reply.body, PNG_BYTES.toString("utf8"));
    });

    it("forces html and svg attachments to download as octet-stream", async () => {
      for (const id of [ATT_HTML, ATT_SVG]) {
        const reply = await request(server.port, `/attachments/${ID_1}/${id}`);
        assert.equal(reply.status, 200);
        assert.equal(reply.headers["content-type"], "application/octet-stream");
        assert.ok(
          String(reply.headers["content-disposition"]).startsWith(
            "attachment;",
          ),
        );
      }
    });

    it("encodes original filenames with an ASCII fallback", async () => {
      const reply = await request(
        server.port,
        `/attachments/${ID_1}/${ATT_PDF}`,
      );
      assert.equal(reply.headers["content-type"], "application/octet-stream");
      assert.equal(
        reply.headers["content-disposition"],
        `attachment; filename="rapport _.pdf"; filename*=UTF-8''rapport%20%C3%A9.pdf`,
      );
    });

    it("404s for files that the entry does not list", async () => {
      assert.equal(
        (await request(server.port, `/attachments/${ID_1}/${UNLISTED}`)).status,
        404,
      );
      assert.equal(
        (await request(server.port, `/attachments/${ID_1}/${MISSING}`)).status,
        404,
      );
    });

    it("404s for traversal attempts", async () => {
      const attempts = [
        `/attachments/${ID_1}/../../etc/passwd`,
        `/attachments/${ID_1}/..%2F..%2Fetc%2Fpasswd`,
        `/attachments/${ID_1}/%2e%2e`,
        `/attachments/${ID_1}/%2E%2E%2F${ID_1}.md`,
        `/attachments/..%2F${ID_1}/${ATT_PNG}`,
        `/attachments/${ID_1}/${ATT_PNG}/../x`,
        `/attachments/${ID_1}/${ATT_PNG}%00`,
      ];
      for (const path of attempts) {
        assert.equal((await request(server.port, path)).status, 404, path);
      }
    });

    it("404s for malformed ids", async () => {
      assert.equal(
        (await request(server.port, `/attachments/nope/${ATT_PNG}`)).status,
        404,
      );
      assert.equal(
        (await request(server.port, `/attachments/${ID_1}/nope`)).status,
        404,
      );
    });
  });

  it("reports PORT_IN_USE when the port is taken", async () => {
    await assert.rejects(createServer({ dir, port: server.port }), {
      code: "PORT_IN_USE",
    });
  });
});

describe("open", () => {
  const spawned: number[] = [];
  let savedHome: string | undefined;

  before(async () => {
    savedHome = process.env.HOME;
    process.env.HOME = await makeTempDir();
  });

  after(async () => {
    for (const pid of spawned.splice(0)) await stopProcess(pid);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("starts a server, then reuses it", async () => {
    const dir = await newNotebook();
    const port = await freePort();
    const first = await openNotebook({ dir, port, noBrowser: true });
    assert.ok(first.pid);
    spawned.push(first.pid);
    assert.equal(first.reused, false);
    assert.equal(first.url, `http://127.0.0.1:${port}/`);
    assert.deepEqual(first.warnings, []);
    assert.equal((await request(port, "/_health")).status, 200);

    const second = await openNotebook({
      dir,
      port,
      noBrowser: true,
      entryId: ID_1,
    });
    assert.equal(second.reused, true);
    assert.equal(second.pid, undefined);
    assert.equal(second.url, entryUrl(ID_1, port));
  });

  it("refuses a port held by another notebook", async () => {
    const other = await newNotebook();
    const port = await freePort();
    const running = await createServer({ dir: await makeTempDir(), port });
    try {
      await assert.rejects(
        openNotebook({ dir: other, port, noBrowser: true }),
        {
          code: "PORT_IN_USE",
        },
      );
    } finally {
      await running.close();
    }
  });

  it("refuses a port held by a foreign listener", async () => {
    const sockets = new Set<Socket>();
    const foreign = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      foreign.listen(0, "127.0.0.1", resolve),
    );
    const { port } = foreign.address() as AddressInfo;
    try {
      await assert.rejects(
        openNotebook({ dir: await newNotebook(), port, noBrowser: true }),
        { code: "PORT_IN_USE" },
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it("does not wait on a listener that trickles bytes forever", {
    timeout: 15_000,
  }, async () => {
    const sockets = new Set<Socket>();
    const trickle = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        clearInterval(timer);
      });
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n");
      const timer = setInterval(() => socket.write(" "), 100);
    });
    await new Promise<void>((resolve) =>
      trickle.listen(0, "127.0.0.1", resolve),
    );
    const { port } = trickle.address() as AddressInfo;
    try {
      const started = Date.now();
      await assert.rejects(
        openNotebook({ dir: await newNotebook(), port, noBrowser: true }),
        { code: "PORT_IN_USE" },
      );
      assert.ok(Date.now() - started < 2500, "probe must give up quickly");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => trickle.close(() => resolve()));
    }
  });

  it("reports opener failures as warnings, and passes the URL to the opener", async () => {
    const dir = await newNotebook();
    const port = await freePort();
    const first = await openNotebook({ dir, port, noBrowser: true });
    spawned.push(first.pid ?? 0);
    const opened: string[] = [];
    const ok = await openNotebook({
      dir,
      port,
      entryId: ID_1,
      opener: async (url) => {
        opened.push(url);
      },
    });
    assert.deepEqual(opened, [entryUrl(ID_1, port)]);
    assert.deepEqual(ok.warnings, []);
    const failed = await openNotebook({
      dir,
      port,
      opener: async () => {
        throw new Error("no browser");
      },
    });
    assert.equal(failed.reused, true);
    assert.equal(failed.warnings.length, 1);
    assert.equal(
      failed.warnings[0]?.includes(`http://127.0.0.1:${port}/`),
      true,
    );
  });
});

async function stopProcess(pid: number): Promise<void> {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
