import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function reportIdentity(bytes) {
  const report = JSON.parse(bytes.toString("utf8"));
  if (report.targetId !== "typescript.KalshiTS") throw new Error("Release report must belong to KalshiTS.");
  if (!Array.isArray(report.checks) || report.checks.length === 0 || report.checks.some((check) => check.passed !== true)) {
    throw new Error("Release conformance report must contain successful checks.");
  }
  if (typeof report.suiteDigest !== "string" || !/^[a-f0-9]{64}$/.test(report.suiteDigest)) {
    throw new Error("Release conformance report must identify its suite.");
  }
  return JSON.stringify({ targetId: report.targetId, suiteDigest: report.suiteDigest,
    checks: report.checks.map(({ id, passed }) => ({ id, passed })).sort((a, b) => a.id.localeCompare(b.id)) });
}

export async function reconcileRelease({ repository, tag, files, prerelease, token,
  fetchImplementation = fetch, run = (args) => execFileSync("gh", args, { stdio: "inherit" }) }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository.");
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error("Invalid release tag.");
  if (!token) throw new Error("GitHub release access is required.");
  const prepared = files.map((file) => ({ file, name: path.basename(file), bytes: readFileSync(file) }));
  if (prepared.length === 0) throw new Error("Prepared release assets are required.");
  if (new Set(prepared.map((file) => file.name)).size !== prepared.length) throw new Error("Duplicate release asset name.");
  for (const file of prepared.filter((file) => file.name === "report.json")) reportIdentity(file.bytes);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const base = `https://api.github.com/repos/${repository}`;
  const response = await fetchImplementation(`${base}/releases/tags/${encodeURIComponent(tag)}`, { headers, signal: AbortSignal.timeout(30000) });
  if (response.status === 404) {
    run(["release", "create", tag, ...files, "--repo", repository, "--verify-tag", "--title", `KalshiTS ${tag}`,
      "--notes", "Node.js ESM SDK with generic REST requests, RSA-PSS authentication, typed fills and pinned KalshiCore fixture checks.",
      ...(prerelease ? ["--prerelease"] : [])]);
    return "created";
  }
  if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
  const release = await response.json();
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== prerelease || !Number.isInteger(release.id)) {
    throw new Error("Existing GitHub release identity/state differs from the prepared release.");
  }
  const assetsResponse = await fetchImplementation(`${base}/releases/${release.id}/assets?per_page=100`, { headers, signal: AbortSignal.timeout(30000) });
  if (!assetsResponse.ok) throw new Error(`GitHub asset lookup failed with HTTP ${assetsResponse.status}.`);
  const assets = await assetsResponse.json();
  if (!Array.isArray(assets) || assets.length >= 100) throw new Error("Ambiguous GitHub asset listing.");
  const missing = [];
  for (const expected of prepared) {
    const matches = assets.filter((asset) => asset.name === expected.name);
    if (matches.length === 0) { missing.push(expected.file); continue; }
    if (matches.length !== 1 || !Number.isInteger(matches[0].id)) throw new Error(`Ambiguous GitHub asset ${expected.name}.`);
    const download = await fetchImplementation(`${base}/releases/assets/${matches[0].id}`, {
      headers: { ...headers, Accept: "application/octet-stream" }, signal: AbortSignal.timeout(30000)
    });
    if (!download.ok) throw new Error(`GitHub asset download failed with HTTP ${download.status}.`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const matchesContent = expected.name === "report.json"
      ? reportIdentity(bytes) === reportIdentity(expected.bytes) : bytes.equals(expected.bytes);
    if (!matchesContent) throw new Error(`Existing GitHub asset differs: ${expected.name}. Refusing to overwrite.`);
  }
  if (missing.length) run(["release", "upload", tag, ...missing, "--repo", repository]);
  return missing.length ? "resumed" : "verified";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [tag, ...files] = process.argv.slice(2);
  console.log(await reconcileRelease({ repository: process.env.GITHUB_REPOSITORY ?? "hurley451/KalshiTS", tag, files,
    prerelease: tag?.includes("-") ?? false, token: process.env.GH_TOKEN }));
}
