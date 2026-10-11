# Releases

The initial release is `0.1.0-alpha.1`, published under npm's `next` dist-tag.
It is not published until registry read-back confirms availability. The SDK
remains a Node.js ESM prerelease with the coverage exclusions documented in
[API_COVERAGE.md](API_COVERAGE.md).

## Release Gates

- Exact version in `package.json` and lockfile, matching an existing Git tag.
- Complete-diff review and passing Node 20/22/24 CI, including packed consumers.
- Immutable KalshiCore commit in `package.json`'s `kalshiCoreRef`.
- Pinned Core tests, validation, operation regeneration comparison and SDK adapter.
- Intended runtime/declaration/docs/license tarball contents.
- npm package ownership and configured trusted publisher or initial authenticated bootstrap.

The initial prerelease pins KalshiCore
[`v0.1.0`](https://github.com/hurley451/KalshiCore/releases/tag/v0.1.0), commit
`ba5d98ed0ec3a1a7a37f0d005eaf36fb23be36b7`. Scheduled drift monitoring remains
separate from this immutable release input.

Published versions are immutable. A failed post-publication check does not
authorize unpublishing or overwriting the version; diagnose and issue a reviewed
follow-up version when needed.

## Trusted Publisher Setup

The repeatable GitHub release workflow is `.github/workflows/release.yml`.
Configure npm trusted publishing for GitHub user `hurley451`, repository
`KalshiTS`, workflow filename `release.yml`, with direct publication allowed.
The workflow uses a GitHub-hosted runner, Node 24, npm 11 and OIDC, not a stored
npm token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The initial package/account ownership bootstrap requires authenticated npm
access. Do not put credentials in source or issue bodies. Creating the GitHub
workflow does not configure the registry trust relationship.

## Publish and Verify

After all gates and account setup are verified, create the reviewed version tag
and push that tag. Manual dispatch may retry an existing tag; it cannot package
the default branch under a different tag name.

The workflow builds and smoke-tests the exact tarball, then retains the tarball,
pack metadata, checksum, source manifest and conformance report as a prepared
Actions artifact before attempting publication. Use that exact artifact for an
authenticated initial bootstrap if the registry account requires it.

After authenticating the package owner and downloading the verified prepared
artifact, bootstrap publication uses its exact tarball and prerelease tag:

```bash
npm publish /path/to/hurley451-kalshi-ts-0.1.0-alpha.1.tgz --access public --tag next
```

Then configure the trusted publisher and resume the same existing Git tag. Do
not rebuild from another commit, publish the prerelease under `latest`, or move
an existing dist-tag backwards as part of recovery.

Only a registry 404 permits new publication. An existing version is accepted only
when its name, version and integrity match the locally verified tarball. Other
registry errors or mismatches fail closed. Reruns can resume after a matching
bootstrap or partial publication; they never overwrite an npm version.

Before consumer checks, the registry's intended `next` or `latest` dist-tag must
point to this exact version. A missing or different mapping halts recovery.
Inspect `npm dist-tag ls @hurley451/kalshi-ts` and the registry release history;
an owner must decide whether a tag correction is appropriate. The workflow never
changes an established tag automatically during recovery.

The workflow then
installs the exact registry version in a separate consumer for runtime and
TypeScript checks and creates a matching GitHub release with the tarball,
SHA-256 checksum and conformance report. Prerelease versions use `next`; stable
versions use `latest`.

Existing GitHub releases must match the tag and prerelease state. Recovery
downloads and verifies existing assets, then uploads only missing assets. Different
content, failed conformance or ambiguous lookups halt without clobbering assets.

Local consumer verification of an existing published version:

```bash
npm ci
npm run test:package -- @hurley451/kalshi-ts@0.1.0-alpha.1
npm view @hurley451/kalshi-ts@0.1.0-alpha.1 version repository license engines dist --json
```

Confirm registry integrity, version, provenance and matching GitHub tag/assets.
Run the public demo status example separately. Credentialed requests and trading
are not part of the deterministic publication smoke checks.

## Drift Monitoring

Pull request/push CI uses the pinned suite; scheduled conformance intentionally
checks current Core `main`. Review a new Core commit and update the package pin
and workflow pin together, with regenerated inventory and tests when needed.
Scheduled parent issue filing additionally requires `KALSHICORE_ISSUE_TOKEN`
with permission to create/comment on Core issues. It is not verified merely by
having a schedule or by passing conformance.
