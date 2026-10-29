import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type SecretFinding,
  scanAttachment,
  scanEntry,
  scanText,
} from "../src/secrets.ts";
import { makeEntry } from "./fixtures.ts";

const SAMPLES: Record<string, string> = {
  "private-key": "-----BEGIN OPENSSH PRIVATE KEY-----",
  "aws-access-key-id": `key AKIA${"IOSFODNN7EXAMPLE"}`,
  "github-token": `ghp_${"A".repeat(36)}`,
  "slack-token": "xoxb-1234567890-abcdefghij",
  "anthropic-key": `sk-ant-api03-${"a".repeat(24)}`,
  "openai-key": `sk-${"a".repeat(24)}`,
  "google-api-key": `AIza${"a".repeat(35)}`,
  "stripe-live-key": `sk_live_${"a".repeat(20)}`,
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk",
  "credential-assignment": 'password: "hunter2hunter2"',
  "url-credentials": "https://alice:s3cretpass@example.com/repo",
};

const DOLLAR = "$";

const PLACEHOLDERS = [
  "password: <your-password>",
  `token = ${DOLLAR}{TOKEN_VALUE}`,
  'api_key: "xxxxxxxxxxxx"',
  "secret: ***********",
  "password: changeme123",
  "token: your_token_here",
  "password: example-password",
  `https://user:${DOLLAR}{PASS}@host.example`,
];

describe("secret rules", () => {
  for (const [rule, sample] of Object.entries(SAMPLES)) {
    it(`detects ${rule}`, () => {
      const rules = scanText(sample, "body").map((finding) => finding.rule);
      assert.ok(rules.includes(rule), `${rule} not in ${rules.join(",")}`);
    });
  }

  it("reports Anthropic keys only as anthropic-key, not openai-key", () => {
    const rules = scanText(SAMPLES["anthropic-key"], "body").map(
      (finding) => finding.rule,
    );
    assert.deepEqual(rules, ["anthropic-key"]);
  });

  it("ignores obvious placeholders", () => {
    for (const line of PLACEHOLDERS) {
      assert.deepEqual(scanText(line, "body"), [], line);
    }
  });

  it("ignores ordinary prose", () => {
    assert.deepEqual(
      scanText("The token bucket algorithm limits requests.", "body"),
      [],
    );
  });
});

describe("scanText locations", () => {
  it("reports one-based line numbers in the body", () => {
    const findings = scanText(`fine\n${SAMPLES.jwt}\n`, "body");
    assert.deepEqual(findings, [{ rule: "jwt", location: "body:line 2" }]);
  });

  it("detects a credential whose value is on the next line", () => {
    const findings = scanText(
      "config:\npassword:\n  actualP4ssword123\n",
      "body",
    );
    assert.deepEqual(findings, [
      { rule: "credential-assignment", location: "body:line 2" },
    ]);
  });

  it("detects URL credentials with a very long password", () => {
    const url = `https://user:${"P4ssw0rd".repeat(70)}@host.example/`;
    assert.deepEqual(scanText(`see ${url}`, "body"), [
      { rule: "url-credentials", location: "body:line 1" },
    ]);
  });

  it("ignores placeholders split across lines", () => {
    assert.deepEqual(
      scanText(
        `password:\n  <your-password>\ntoken:\n  ${DOLLAR}{TOKEN}\nsecret:\n\n  example-secret\n`,
        "body",
      ),
      [],
    );
  });
});

describe("scanText performance", () => {
  const SIZE = 2 * 1024 * 1024;
  const BASE64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = 7;
  const randomBase64 = Array.from({ length: SIZE }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return BASE64[seed % BASE64.length];
  }).join("");
  const patterns: Record<string, string> = {
    "a.": "a.",
    "a:": "a:",
    "password=": "password=",
    "password:\n": "password:\n",
    "-": "-",
    "-eyJ": "-eyJ",
    eyJ: "eyJ",
    "://": "://",
    "a://": "a://",
  };

  for (const [name, unit] of Object.entries(patterns)) {
    it(`scans 2 MiB of "${name}" in under a second`, () => {
      const text = unit.repeat(Math.ceil(SIZE / unit.length));
      const started = performance.now();
      scanText(text, "body");
      assert.ok(performance.now() - started < 1000, `${name} is too slow`);
    });
  }

  it("scans a 2 MiB URL authority without delimiters in under a second", () => {
    const text = `https://${"a:".repeat(SIZE / 2)}`;
    const started = performance.now();
    scanText(text, "body");
    assert.ok(performance.now() - started < 1000, "long authority is too slow");
  });

  it("scans 2 MiB of random base64 in under a second", () => {
    const started = performance.now();
    scanText(randomBase64, "body");
    assert.ok(performance.now() - started < 1000, "random base64 is too slow");
  });
});

describe("scanEntry", () => {
  it("scans front matter fields and the body with field locations", () => {
    const entry = makeEntry({
      title: `Leaked ${SAMPLES["openai-key"]}`,
      sources: [{ kind: "url", url: "https://alice:s3cretpass@example.com" }],
    });
    const findings = scanEntry(entry, `Notes\n${SAMPLES.jwt}\n`);
    const locations = findings.map((finding) => finding.location);
    assert.ok(locations.includes("frontmatter:title"));
    assert.ok(locations.includes("frontmatter:sources[0].url"));
    assert.ok(locations.includes("body:line 2"));
  });

  it("returns no findings for a clean entry", () => {
    assert.deepEqual(scanEntry(makeEntry(), "Plain body.\n"), []);
  });

  it("never includes matched secret text in findings", () => {
    const secrets = [SAMPLES["openai-key"], SAMPLES.jwt, "hunter2hunter2"];
    const entry = makeEntry({ title: `t ${secrets[0]}` });
    const findings: SecretFinding[] = [
      ...scanEntry(entry, `${secrets[1]}\npassword: hunter2hunter2\n`),
    ];
    assert.ok(findings.length >= 3);
    const serialized = JSON.stringify(findings);
    for (const secret of secrets) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

describe("scanAttachment", () => {
  it("scans text-like bytes", () => {
    const bytes = new TextEncoder().encode(`config\n${SAMPLES.jwt}\n`);
    assert.deepEqual(scanAttachment("notes.txt", bytes), [
      { rule: "jwt", location: "attachment:content:line 2" },
    ]);
  });

  it("does not scan binary bytes containing NUL", () => {
    const bytes = new TextEncoder().encode(`\0${SAMPLES.jwt}`);
    assert.deepEqual(scanAttachment("blob.bin", bytes), []);
  });

  it("does not scan invalid UTF-8", () => {
    const bytes = new Uint8Array([
      0xff,
      0xfe,
      ...new TextEncoder().encode(SAMPLES.jwt),
    ]);
    assert.deepEqual(scanAttachment("blob.dat", bytes), []);
  });

  it("scans the original file name without echoing it", () => {
    const findings = scanAttachment(
      `${SAMPLES["openai-key"]}.txt`,
      new Uint8Array(),
    );
    assert.deepEqual(findings, [
      { rule: "openai-key", location: "attachment:filename" },
    ]);
    assert.equal(JSON.stringify(findings).includes("sk-"), false);
  });
});
