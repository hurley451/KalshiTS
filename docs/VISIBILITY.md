# KalshiTS Visibility Tracking

## Baseline

Captured from the GitHub repository API on 2026-10-11.

| Metric | Value |
|--------|-------|
| GitHub stars | 0 |
| Forks | 0 |
| Watchers/subscribers | 0 |
| Registry package | `@hurley451/kalshi-ts`, not yet published |

Traffic, contributor counts, external references, and package downloads were not
captured in this baseline. Do not treat missing measurements as zero.

## Monthly Checks

Run from this repository with authenticated GitHub access:

```bash
gh repo view --json nameWithOwner,description,homepageUrl,repositoryTopics,stargazerCount,forkCount
gh api repos/hurley451/KalshiTS --jq .subscribers_count
gh api repos/hurley451/KalshiTS/contributors --paginate --jq '.[].login'
gh api repos/hurley451/KalshiTS/traffic/views
gh api repos/hurley451/KalshiTS/traffic/clones
gh api repos/hurley451/KalshiTS/traffic/popular/referrers
gh api repos/hurley451/KalshiTS/traffic/popular/paths
gh api 'search/code?q=%22%40hurley451%2Fkalshi-ts%22+-repo:hurley451/KalshiTS'
gh api 'search/issues?q=%22KalshiTS%22+-repo:hurley451/KalshiTS'
npm view @hurley451/kalshi-ts version repository keywords --json
```

GitHub traffic provides a rolling 14-day window and requires appropriate repository
access. Save dated snapshots outside committed source when tracking longer trends.
Search results are directional: private usage and unindexed references are absent,
and bot/catalog mirrors can inflate apparent adoption.

## Discovery Objectives

- Keep About metadata and topics specific to Kalshi, prediction markets, and the language.
- Keep installation, examples, coverage boundaries, and support easy to find.
- Cross-link KalshiCore and sibling SDKs so users can choose their language.
- Use small working examples and specific issue titles to attract useful references.
- Measure external usage separately from catalog mirrors and automated clones.

## Ecosystem Details

npm metadata includes TypeScript, JavaScript, Node.js, Kalshi API, trading, and prediction-market keywords.
After publication, add npm version and download badges and track npm download trends.
Only advertise Node.js ESM support; authentication depends on Node.js crypto.
