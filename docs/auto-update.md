# Auto-Update — Operator Guide

Scribble ships with Tauri's `plugin-updater` wired up. When a new tag is pushed,
GitHub Actions builds installers for all three platforms, signs them with a
minisign keypair, and publishes a `latest.json` manifest. Clients poll that
manifest, verify the signature, download the new binary, and relaunch.

This doc covers the one-time setup (keypair + GH secrets) and the per-release
flow. Read it once, follow the runbook, and from then on every `git tag vX.Y.Z`
push gives users a one-click in-app update.

---

## How it fits together

```
┌──────────────┐                           ┌────────────────────────┐
│  git tag vX  │  ─push──►                 │  GitHub Actions        │
└──────────────┘                           │  ─────────────────     │
                                           │  build.yml       (Win) │
                                           │  build-linux.yml       │
                                           │  build-macos.yml       │
                                           │      │                 │
                                           │      ▼ (each uploads   │
                                           │   installer + .sig)    │
                                           │                        │
                                           │  release-manifest.yml  │
                                           │      │                 │
                                           │      ▼ polls release   │
                                           │   for .sig files,      │
                                           │   builds latest.json,  │
                                           │   uploads it           │
                                           └──────────┬─────────────┘
                                                      │
                                                      ▼
              ┌──────────────────────────────────────────────────────┐
              │  https://github.com/<owner>/Scribble/releases/       │
              │     latest/download/latest.json                      │
              └──────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────────┐
                       │  Tauri client (running app) │
                       │  check() → compare versions │
                       │  → download .app.tar.gz /   │
                       │    .exe / .AppImage         │
                       │  → verify .sig vs pubkey    │
                       │  → relaunch                 │
                       └─────────────────────────────┘
```

The minisign **public key** is baked into `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`). The **private key** lives in two places:
1. The user's local machine (so they can build + sign locally if needed)
2. GitHub Actions secrets (`TAURI_SIGNING_PRIVATE_KEY` + password)

The client refuses any update whose `.sig` doesn't verify against the embedded
pubkey. That's the entire trust model — no Apple Developer ID or Microsoft
Authenticode involved. (Those are separate concerns: Gatekeeper / SmartScreen.
The updater works without them.)

---

## One-time setup (you only do this once, ever)

### 1. Generate a Tauri signing keypair

```bash
# From the project root. The key file holds both private + public.
npx tauri signer generate -w ~/.tauri/scribble.key
```

You'll be prompted for a password. **Pick a strong one and store it in a
password manager** — losing it means you can never publish another update
without a forced re-key (which would lock out every existing installed user).

The command writes two files:
- `~/.tauri/scribble.key`     — the **private** key (NEVER commit, NEVER share)
- `~/.tauri/scribble.key.pub` — the **public** key (this goes in tauri.conf.json)

### 2. Confirm `tauri.conf.json` has the matching pubkey

```bash
cat ~/.tauri/scribble.key.pub
# Compare against:
grep pubkey src-tauri/tauri.conf.json
```

The base64 string on the second line of `scribble.key.pub` must match the
`pubkey` value in `tauri.conf.json` (also base64). If they don't, the existing
pubkey was generated for a different private key — either replace
`tauri.conf.json`'s pubkey with this new one, OR find the matching private key.

### 3. Add the private key to GitHub Actions secrets

```bash
# Copy the file contents into the clipboard (macOS):
cat ~/.tauri/scribble.key | pbcopy
```

Then go to `https://github.com/<owner>/Scribble/settings/secrets/actions` and
add two secrets:

| Secret name | Value |
|-------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY`          | Paste the contents of `scribble.key` (full multi-line text including the `untrusted comment:` header) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set in step 1 |

That's the entire setup. From now on, every CI build will be signed.

---

## Per-release runbook

```bash
# 1. Bump version in three places:
#    - package.json
#    - src-tauri/Cargo.toml + Cargo.lock (the [package] table)
#    - src-tauri/tauri.conf.json

# 2. Commit + tag + push
git commit -am "chore(release): bump X.Y.Z → X.Y.(Z+1)"
git tag v1.2.1
git push origin main --tags

# 3. Wait. GH Actions does the rest:
#    - 3 build workflows run in parallel (~15-25 min each)
#    - release-manifest.yml polls until all signed artifacts are present,
#      then generates + uploads latest.json
#    - Release stays in draft until you publish it (or set `--draft=false`
#      on the gh CLI). Existing installs see the update only once
#      latest.json is reachable.

# 4. Publish the release as "Latest"
gh release edit v1.2.1 --draft=false --latest --notes "$(cat <<'EOF'
## What's new
- ...
EOF
)"
```

After step 4, every running client will detect the update within their next
30-minute auto-check cycle (or immediately if the user hits "Check for updates"
in Settings).

---

## Validating that auto-update works

```bash
# 1. Confirm latest.json is reachable
curl -sL https://github.com/<owner>/Scribble/releases/latest/download/latest.json | jq

# Expected structure:
# {
#   "version": "v1.2.1",
#   "notes": "...",
#   "pub_date": "2026-05-15T12:34:56Z",
#   "platforms": {
#     "darwin-aarch64":   { "signature": "untrusted comment: ...", "url": "..." },
#     "windows-x86_64":   { "signature": "...",                    "url": "..." },
#     "linux-x86_64":     { "signature": "...",                    "url": "..." }
#   }
# }

# 2. Install the previous version. Open the app. Open Settings → App Updates →
#    "Check for updates". You should see the new version appear.
```

If `latest.json` is 404 → `release-manifest.yml` either failed or hasn't run
yet. Check `gh run list -w "Release Manifest"` for the latest run status.

If `latest.json` exists but the client says "Update server unreachable" →
check that the `endpoints` URL in `tauri.conf.json` matches what's actually
deployed.

If the client downloads but fails signature check → the private key used by CI
doesn't match the pubkey in `tauri.conf.json`. Regenerate or re-import.

---

## Code map

```
src-tauri/
  tauri.conf.json                    # plugins.updater.{endpoints,pubkey} + bundle.createUpdaterArtifacts
  Cargo.toml                         # tauri-plugin-updater + tauri-plugin-process
.github/workflows/
  build.yml                          # Windows  — passes TAURI_SIGNING_PRIVATE_KEY env, uploads .sig
  build-linux.yml                    # Linux    — same
  build-macos.yml                    # macOS    — same + uploads .app.tar.gz updater artifact
  release-manifest.yml               # waits for all 3 sig files, generates latest.json
src/
  components/UpdateChecker.tsx       # orchestrator: starts auto-check loop, mounts banner + modal
  components/UpdateBanner.tsx        # slim banner in corner — "View / Later"
  components/UpdateModal.tsx         # full release-notes + download progress + Skip / Later / Update
  stores/updaterStore.ts             # shared zustand state (status, progress, modal open, etc)
  lib/updater.ts                     # checkForUpdates / downloadAndInstall helpers
  components/SettingsPanel.tsx       # "Check for updates" button + auto-check toggle (sources from updaterStore)
docs/
  auto-update.md                     # this file
```

---

## Notes + caveats

- **deb is not an updater target.** Tauri's Linux updater only supports
  AppImage. Users who installed via `.deb` need to upgrade manually
  (apt/dpkg) — they won't see in-app prompts.
- **macOS arm64 only.** `build-macos.yml` builds on `macos-14` (M-series).
  Intel Mac users will need a separate Rosetta-compatible build or a
  cross-compile. Not configured yet.
- **No notarization.** CI builds use ad-hoc signing (`signingIdentity: "-"`).
  Gatekeeper users right-click → Open the first time. For notarized
  releases, build locally with the Developer ID identity and upload manually
  to the release.
- **Skip a version.** The Settings "Clear skip" row only appears after the
  user has skipped a version. Clearing it makes the banner / modal reappear
  for that version on next check.
- **Manifest partial coverage.** If only 2 of 3 platforms upload signatures
  (e.g. Windows build fails), `release-manifest.yml` still generates a
  manifest with the 2 working platforms. Clients on the missing platform
  silently see "up to date" — not ideal, but better than failing the
  release. Fix the broken build, re-run the workflow, and the manifest
  regenerates with full coverage.
