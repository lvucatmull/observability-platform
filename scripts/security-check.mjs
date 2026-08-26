import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
} catch {
  tracked = [];
}

const forbiddenFiles = tracked.filter(
  (file) => file === ".env" || (file.startsWith(".env.") && file !== ".env.schema"),
);

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Google OAuth secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/],
  ["Grafana generated password", /^GRAFANA_ADMIN_PASSWORD=[^$\s][^\s]{15,}$/m],
];

const findings = [];
for (const file of tracked) {
  let content;
  try {
    content = await readFile(resolve(root, file), "utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) findings.push(`${file}: ${label}`);
  }
}

try {
  const envStat = await stat(resolve(root, ".env"));
  if ((envStat.mode & 0o077) !== 0) findings.push(".env: permissions must be 0600");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (forbiddenFiles.length || findings.length) {
  console.error(
    [...forbiddenFiles.map((file) => `${file}: local environment file is tracked`), ...findings].join(
      "\n",
    ),
  );
  process.exit(1);
}

console.log("Sensitive-file check passed.");
