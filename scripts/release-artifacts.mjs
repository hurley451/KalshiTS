import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const packageVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const distTagRecovery = "Stop recovery and review the current npm dist-tags and release order. Resolve the intended tag manually only after confirming it will not move an established tag backward, then rerun verification. This helper never changes dist-tags.";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filename, label) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new Error(`Cannot read valid ${label} JSON.`);
  }
}

// npm pack writes the archive in cwd even when its JSON is redirected elsewhere.
export async function readPreparedArtifact(metadataPath, { cwd = process.cwd(), archivePath } = {}) {
  const entries = await readJson(metadataPath, "npm pack metadata");
  requireValue(Array.isArray(entries) && entries.length === 1, "Expected exactly one npm pack artifact.");
  const pack = entries[0];
  requireValue(pack && typeof pack === "object" && !Array.isArray(pack), "Invalid npm pack artifact.");
  requireValue(typeof pack.name === "string" && packageName.test(pack.name), "Invalid package name.");
  requireValue(typeof pack.version === "string" && packageVersion.test(pack.version), "Invalid package version.");
  requireValue(typeof pack.filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(pack.filename), "Invalid archive filename.");
  requireValue(typeof pack.integrity === "string" && sha512Integrity.test(pack.integrity), "Expected a single SHA-512 integrity.");
  const archive = path.resolve(cwd, archivePath ?? pack.filename);
  requireValue(path.basename(archive) === pack.filename, "Archive filename does not match npm pack metadata.");
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    throw new Error("Cannot read prepared archive.");
  }
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  requireValue(integrity === pack.integrity, "Prepared archive integrity does not match npm pack metadata.");
  return {
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    integrity,
  };
}

async function registryJson(url, {
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}, allowNotFound = false) {
  requireValue(typeof fetchImpl === "function", "A fetch implementation is required.");
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, "Invalid registry timeout.");
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Registry inspection timed out."));
    }, timeoutMs);
  });
  try {
    // Bound both fetch and body decoding, including fetch doubles that ignore abort.
    return await Promise.race([deadline, (async () => {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new Error("Registry request failed.");
      }
      requireValue(response && Number.isInteger(response.status), "Invalid registry response.");
      if (allowNotFound && response.status === 404) return { status: 404 };
      requireValue(response.status === 200, "Registry returned an unexpected status.");
      let published;
      try {
        published = await response.json();
      } catch {
        throw new Error("Registry returned malformed package JSON.");
      }
      return { status: 200, body: published };
    })()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function inspectNpm(metadataPath, options = {}) {
  const artifact = await readPreparedArtifact(metadataPath, options);
  const response = await registryJson(
    `https://registry.npmjs.org/${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`,
    options, true,
  );
  if (response.status === 404) return { needsPublish: true, artifact };
  const published = response.body;
  requireValue(published && !Array.isArray(published)
    && published.name === artifact.name && published.version === artifact.version
    && published.dist?.integrity === artifact.integrity,
  "Published package identity or integrity does not match the prepared artifact.");
  return { needsPublish: false, artifact };
}

export async function verifyNpmDistTag(metadataPath, distTag, options = {}) {
  requireValue(distTag === "next" || distTag === "latest", "Expected npm dist-tag next or latest.");
  const { needsPublish, artifact } = await inspectNpm(metadataPath, options);
  requireValue(!needsPublish, `Published package version is absent. ${distTagRecovery}`);
  const { body } = await registryJson(`https://registry.npmjs.org/${encodeURIComponent(artifact.name)}`, options);
  requireValue(body && !Array.isArray(body) && body.name === artifact.name,
    "Registry returned an invalid package identity.");
  const tags = body["dist-tags"];
  requireValue(tags && typeof tags === "object" && !Array.isArray(tags)
    && Object.hasOwn(tags, distTag) && tags[distTag] === artifact.version,
  `npm dist-tag is missing or does not match the prepared version. ${distTagRecovery}`);
  requireValue(!artifact.version.split("+")[0].includes("-") || tags.latest !== artifact.version,
    `npm latest must not point to the prepared prerelease artifact. ${distTagRecovery}`);
  return { artifact, distTag };
}

export async function createReleaseManifest(metadataPath, { cwd = process.cwd(), ...artifactOptions } = {}) {
  const artifact = await readPreparedArtifact(metadataPath, { cwd, ...artifactOptions });
  const pkg = await readJson(path.join(cwd, "package.json"), "package");
  requireValue(pkg?.name === artifact.name && pkg?.version === artifact.version, "Package identity does not match the prepared artifact.");
  requireValue(typeof pkg.kalshiCoreRef === "string" && /^[a-f0-9]{40}$/.test(pkg.kalshiCoreRef), "KalshiCore must be pinned to a full commit SHA.");
  let gitHead;
  try {
    gitHead = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    }).trim();
  } catch {
    throw new Error("Cannot resolve release git HEAD.");
  }
  requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitHead), "Invalid release git HEAD.");
  return {
    name: artifact.name,
    version: artifact.version,
    sourceCommit: gitHead,
    kalshiCoreRef: pkg.kalshiCoreRef,
    archive: artifact.filename,
    integrity: artifact.integrity,
  };
}

export async function runCli(args, { env = process.env, stdout = process.stdout, ...options } = {}) {
  const [command, metadataPath, outputPath] = args;
  requireValue(metadataPath && ((command === "inspect-npm" && args.length === 2)
    || (command === "manifest" && args.length === 3 && outputPath)
    || (command === "verify-dist-tag" && args.length === 3 && ["next", "latest"].includes(outputPath))),
  "Usage: release-artifacts.mjs inspect-npm <pack-metadata.json> | manifest <pack-metadata.json> <output.json> | verify-dist-tag <pack-metadata.json> <next|latest>");
  if (command === "verify-dist-tag") {
    await verifyNpmDistTag(metadataPath, outputPath, options);
    return;
  }
  if (command === "manifest") {
    const manifest = await createReleaseManifest(metadataPath, options);
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const result = await inspectNpm(metadataPath, options);
  const output = `needs-publish=${result.needsPublish}\n`;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, output);
  stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(() => {
    // Do not echo registry bodies, fetch errors, environment values, or credentials.
    if (process.argv[2] === "verify-dist-tag") {
      console.error("npm dist-tag verification failed. Inspect npm tags and release state before recovery.");
      console.error(distTagRecovery);
    } else {
      console.error("Release artifact check failed. Verify arguments, artifact integrity, and registry availability.");
    }
    process.exitCode = 1;
  });
}
