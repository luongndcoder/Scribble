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

### Landing page

**No action needed.** The landing page (`landing/index.html`, deployed by
Vercel on every push to `main`) hydrates its three download cards from
`https://api.github.com/repos/luongndcoder/Scribble/releases/latest` on
page load. As soon as you publish a release as Latest (step 4), the
landing's download URLs + filenames + sizes automatically point at the
new release on next page load.

Cache lives in the visitor's localStorage for 10 min. Power-users
visiting right after a release publish either won't see the new version
until cache expiry, or can hard-refresh.

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

## Persisting macOS permissions across updates (TCC fix)

By default, CI builds use **ad-hoc signing** (`signingIdentity: "-"`). Every
build gets a different code-signing hash, which causes macOS TCC (the
Privacy & Security database tracking mic / screen-recording / system-audio
permissions) to treat each new release as a brand-new app — and re-prompt the
user to grant permissions on **every single update**. Extremely annoying.

The fix is to sign every release with the **same** code-signing identity, so
TCC sees the same designated requirement and keeps prior grants alive. You
don't need a paid Apple Developer ID for this — a free self-signed cert works.

### One-time setup (5 minutes)

#### Step 1 — Create a code-signing certificate

1. Open **Keychain Access** (⌘+Space → "Keychain Access")
2. Menu: **Keychain Access** → **Certificate Assistant** → **Create a Certificate…**
3. Fill in:
   - **Name**: `Scribble Code Signing` (or any name — this will be the identity)
   - **Identity Type**: `Self Signed Root`
   - **Certificate Type**: `Code Signing`
   - Leave "Let me override defaults" **unchecked**
4. Click **Create** → **Continue** → **Done**

The new cert appears in the **login** keychain under "My Certificates".

#### Step 2 — Export the cert as a .p12 file

1. In Keychain Access, select the cert from step 1
2. Right-click → **Export "Scribble Code Signing"**
3. **File Format**: `Personal Information Exchange (.p12)` (NOT .cer!)
4. Save somewhere private — e.g. `~/Desktop/scribble-cert.p12`
5. When prompted, set a **password** (you'll need it in step 3)
6. macOS may also ask for your **login password** to allow the export — type it

#### Step 3 — Base64-encode + upload to GH secrets

```bash
# Base64-encode the .p12 and copy to clipboard
base64 -i ~/Desktop/scribble-cert.p12 | pbcopy
```

Then go to `https://github.com/<owner>/Scribble/settings/secrets/actions` and
add two more secrets (in addition to the `TAURI_SIGNING_*` ones):

| Secret name | Value |
|-------------|-------|
| `MACOS_CERTIFICATE_P12`       | Paste the base64 string from clipboard |
| `MACOS_CERTIFICATE_PASSWORD`  | The .p12 password you set in step 2 |

#### Step 4 — Delete the local .p12

```bash
rm ~/Desktop/scribble-cert.p12
```

The cert still lives in your Keychain (you can re-export anytime). The
base64 copy is now in GitHub secrets. Don't leave a plaintext .p12 lying
around.

### What this gives you

- ✅ macOS permissions (mic, system audio, screen recording, etc.) **persist
  across all future auto-updates**. User grants once, never asked again.
- ✅ Workflow is unchanged in shape — just one extra step that activates only
  if the secrets exist. If you forget to add them, builds still succeed,
  just with the old ad-hoc behavior.

### What this does NOT give you

- ❌ Gatekeeper trust. The first install (DMG) still triggers "unidentified
  developer" — user right-clicks → Open once. After that, the app launches
  normally. (For Gatekeeper-clean releases you need a paid Apple Developer
  ID and notarization — see "Notes + caveats" below.)
- ❌ Retroactive permission persistence. Users updating from v1.2.6 (ad-hoc)
  to your first signed release will still get re-prompted once. From that
  release onward, prompts stop.

### Verify it's working

After the next release built with the cert, check the .app's signature:

```bash
codesign -dvv /Applications/Scribble.app 2>&1 | grep -E 'Authority|TeamIdentifier'
# Should show: Authority=Scribble Code Signing  (your cert name)
# NOT:         Authority=(ad-hoc)
```

If you see `(ad-hoc)`, the cert didn't get imported in CI. Check the build
log for `::warning::No MACOS_CERTIFICATE_P12 secret`.

---

## Notes + caveats

- **deb is not an updater target.** Tauri's Linux updater only supports
  AppImage. Users who installed via `.deb` need to upgrade manually
  (apt/dpkg) — they won't see in-app prompts.
- **macOS arm64 only.** `build-macos.yml` builds on `macos-14` (M-series).
  Intel Mac users will need a separate Rosetta-compatible build or a
  cross-compile. Not configured yet.
- **No notarization.** Even with a self-signed cert, the DMG isn't notarized.
  Gatekeeper users right-click → Open the first install. For fully-notarized
  releases you need an Apple Developer ID ($99/year) — that's a separate
  upgrade path. The TCC-stability fix above gives you 90% of the UX
  improvement at $0.
- **Skip a version.** The Settings "Clear skip" row only appears after the
  user has skipped a version. Clearing it makes the banner / modal reappear
  for that version on next check.
- **Manifest partial coverage.** If only 2 of 3 platforms upload signatures
  (e.g. Windows build fails), `release-manifest.yml` still generates a
  manifest with the 2 working platforms. Clients on the missing platform
  silently see "up to date" — not ideal, but better than failing the
  release. Fix the broken build, re-run the workflow, and the manifest
  regenerates with full coverage.
