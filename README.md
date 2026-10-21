# Silo

A local-first file browser built with Electron, React, and TypeScript. Browse drives, Time Machine backups, phones, and Google accounts from one interface — with offline semantic search, face grouping, and non-destructive "digital folders".

## Silo links

- [Try Silo website](https://trysilo.kolektivkrog.si/)
- [Silo Downloads](https://github.com/ilovespectra/silo-downloads/releases)
- [Silo user guide](https://silohelp.kolektivkrog.si/)
- [Silo source on GitHub](https://github.com/ilovespectra/Silo)

## Features

### Browsing

- 📁 Browse directories, files, and Time Machine snapshots
- 🗄️ **Sources (Volumes)** — local folders, phones, and Google accounts all appear in one list, each with a checkbox
- ⚡ **Explode** — flatten every nested file into a single view, across every selected source at once
- 🔍 Filter by type, sort by name/size/date/type
- 🎨 List and grid views with lazy-loaded thumbnails
- 🖼️ Full-screen viewer with zoom, plus **audio and video playback**
- 🗂️ **Digital folders** — group files by reference without moving anything on disk

### On-device search and indexing

- 🧠 Semantic search over images and documents via a local CLIP model (model files may need to download before first use)
- 👤 Face detection and clustering into named people
- 🐾 Pet photo clustering
- 🎚️ Confidence threshold control

### Connected sources

- 📱 **Connect a Phone** — iPhone and Android, auto-detected
- ☁️ **Google Drive** — browse and preview in Files (read-only UI)
- 🖼️ **Google Photos** — select photos through the official Picker
- 👥 **Multiple Google accounts** — stay signed in to several at once and view every Drive and picked photo in one merged place

Phone and cloud sources support browsing, previews, Explode, Digital Folders, and saving separate copies to this device. Check each action label: source-changing controls depend on the source type. Connected sources need a device or network connection; search and face analysis run locally after their model files are available.

## Prerequisites

- Node.js 16+ and npm

## Installation

```bash
git clone https://github.com/ilovespectra/Silo.git
cd Silo
npm install
```

### Opening Silo the first time

Preview builds are ad-hoc signed, not Developer ID signed or notarized, so macOS may say it cannot verify Silo. Continue only if you downloaded Silo from the official release page and its published SHA-256 checksum matches.

On recent versions of macOS:

1. Drag `Silo.app` into **Applications**, then try opening it once. If macOS blocks it, choose **Done**.
2. Open **System Settings → Privacy & Security** and choose **Open Anyway** beside Silo under Security.
3. Confirm **Open** (enter your Mac password if asked). This exception applies only to Silo.

If macOS says Silo **is damaged** or **will damage your computer**, stop and do not bypass that alert. Re-download from the official release page, verify the checksum, and contact Silo support if it persists.

## Preview release and license status

Silo 2.0.6 is a test preview. Its $25 lifetime license is intended for **one computer**; each computer needs its own verified purchase. Configuration export/import can transfer settings and indexes, but it excludes paid and beta licenses and the installation ID. Treat configuration exports as sensitive because they can contain account credentials.

End-to-end payment, signed activation, and one-computer enforcement still require verification on installed 2.0.6 builds. A ready relay health check confirms service availability only; it does not prove a payment or license activation.

## Development

```bash
npm run dev
```

Starts the React dev server and Electron together.

## Building

```bash
npm run build   # compile renderer + main
npm start       # run the built app
npm run dist    # package into release/
```

The main-process TypeScript build explicitly includes `src/types.d.ts` for
shared renderer/IPC declarations. Keep it in `tsconfig.json` alongside the
main-process and worker entry points.

### Building the 2.0.6 test preview

On the release Mac, after the 2.0.6 changes are committed and pushed to GitHub
`main`, run:

```bash
npm run repackage_binaries
```

The script builds both Mac DMGs and updater ZIPs locally, merges their
`latest-mac.yml` manifests, and dispatches the Windows installer workflow for
the same `main` commit. It stages the three installable builds and Mac updater
metadata in `~/Downloads/SILO 2.0.6 TEST/` only after every build succeeds. It
replaces an unpublished local bundle only after all fresh assets are staged. Upload the two ZIPs and
`latest-mac.yml` with the DMGs to a release before testing in-app Mac updates.

Automatic release increments roll patch 9 into the next minor version:
`2.0.8 → 2.0.9 → 2.1.0 → 2.1.1`. An existing `2.0.10` also advances
to `2.1.0`; existing release tags and assets are not renamed.
Run `node test/runReleaseVersionTests.cjs` to verify rollover behavior.

If the Windows installer was obtained through another authenticated route, set
both `SILO_WINDOWS_SETUP_EXE` to that non-empty installer file and
`SILO_WINDOWS_BUILD_SHA` to the exact pushed `main` commit used to build it. The
script rejects a mismatched commit. Without those two variables, GitHub CLI
(`gh`) must be installed and authenticated with permission to run this
repository's Actions workflow. `SILO_RELEASE_STAGE_DIR` selects the temporary
staging parent, and `SILO_RELEASE_DEST` overrides the default Downloads folder.
The latest published stable release from `ilovespectra/silo-downloads/releases/latest`
is the only version baseline. Source package versions, local bundles, drafts,
`SILO_RELEASE_VERSION`, and saved build history cannot advance or pin it.
Published `v2.2.9` always builds `2.3.0`, including retries, until `v2.3.0` is published.
The script sets and pushes the package version before building both platforms,
even when correcting an accidentally higher source version. GitHub lookup failures
stop the build instead of falling back to local state.
The script refuses a non-`main` branch, tracked or staged changes, unexpected
untracked files, published destination versions, or a local commit that does not
match GitHub `main`. It prints SHA-256 hashes after copying. It does not publish
a GitHub release; Mac builds remain ad-hoc signed and are not notarized.

`npm run release:check` validates the compiled renderer before packaging.
The Solana Pay check requires the payment section, QR container, and wallet
action markers rather than matching the instructional headline, so copy changes
do not incorrectly block a release.

## Optional CLIP-index image generator

The standalone [Python generator](scripts/generate_from_silo_clip_index.py) reads
Silo's `semantic-index/records.jsonl` journal and normalized 512-dimensional
float32 vectors in `vectors.bin`. It never modifies the index. The entire journal
is replayed before selection so deleted, failed, and superseded entries are excluded.
Large journals can take time and memory to replay; close Silo first for a stable snapshot.

Use a separate Python 3.11+ environment:

```bash
python3.11 -m venv ~/.venvs/clipgen
source ~/.venvs/clipgen/bin/activate
pip install torch diffusers transformers accelerate safetensors pillow
python scripts/generate_from_silo_clip_index.py --mode caption --output ~/Desktop/generated.png
```

By default, the script reads the destination in Silo's `index-storage.json`
under its `file-browser-electron` app-data directory (or `FILE_BROWSER_USER_DATA_DIR`).
Use `--index-dir "/path/to/semantic-index"` for an explicit index, a local fallback,
or a cache in migration; it does not automatically choose between multiple caches.

- `--mode img2img` (default): generate a variation of a random available indexed
  image, using filename metadata as the prompt or your `--prompt`.
- `--mode caption`: locally caption an available image with BLIP, then generate a
  new image from the caption. This does not condition diffusion on the source image.
- `--mode retrieve`: read one stored image vector and retrieve the closest prompt
  from a candidate pool using `openai/clip-vit-base-patch32`, the unquantized
  counterpart of Silo's `Xenova/clip-vit-base-patch32`. Similarities can differ
  from Silo's quantized encoder. This does not decode the vector into a caption
  and does not read the original image. Use `--prompt-pool prompts.txt` for a larger
  pool (one nonempty prompt per line); the built-in pool is deliberately small.

All modes accept `--seed`, `--steps`, `--model-id` (also `--model`), and
`--device auto|cpu|cuda|mps`. Img2img also accepts `--strength`.
Use `--record-path` to select a specific live indexed path. An explicit `--prompt`
skips index access in caption/retrieve modes. Each generated image gets a
`.png.txt` prompt sidecar (or the equivalent for your chosen output extension).
CUDA and Apple Silicon MPS are detected automatically; CPU is much slower.
Model weights may download on first use, but images and index data stay local.
The diffusion model's safety checker remains enabled.

---

## Sources

Everything you connect — a local folder, an iPhone, an Android phone, a Google Drive, a set of picked Google Photos — becomes a **source** in the Volumes panel. They are all equivalent: a phone is not a special mode, just another source.

Each source has a checkbox.

- **Browse selected** opens every ticked source together. Collapsed it shows one folder per source; with **Explode** on it flattens every file from every ticked source into a single list.
- Unticking a source removes it from that combined view without disconnecting it, so you can explode just two phones, or just your work Drive, without the noise of everything else.
- Because digital folders are built from whatever you can currently see, narrowing the selection first is the quickest way to assemble one from specific devices.
- The chevron on a row opens that single source on its own.

Selections persist across restarts. New sources are enabled by default — only your exclusions are stored, so connecting a phone never silently hides it.

---

## Time Machine and Full Disk Access

Time Machine snapshots live under `/Volumes/.timemachine/<UUID>/` and are protected by macOS privacy controls. Without **Full Disk Access** every directory read there fails with `Operation not permitted`, which looks like an empty backup rather than a permissions problem — collapsed you see a couple of folders, and exploding shows nothing at all.

The app now detects this and shows a banner naming the exact entry to enable, with buttons to open the right Settings pane and to reveal the bundle in Finder so it can be dragged into the list.

To grant it:

1. **System Settings → Privacy & Security → Full Disk Access**
2. Enable **silo** (use **+** and pick the revealed bundle if it is not listed)
3. **Quit and reopen the app** — macOS only re-evaluates access at launch

### Development builds

The supported development launch commands (`npm run dev`, `npm start`, and `npm run electron-start`) brand and re-sign the macOS development bundle as **Silo** before Electron starts. Grant Full Disk Access to **Silo**, then quit and reopen the app. If an older **Electron** entry remains from a previous build, remove it and grant access to the current **Silo** entry.

For a direct `electron .` launch outside those scripts, run `npm run brand-dev` first. `npm run unbrand-dev` restores Electron's original development bundle metadata.

> macOS does not let an application add itself to Full Disk Access, nor highlight its own row in System Settings. Opening the exact pane and revealing the bundle for dragging is as far as any app can go.

---

## Connecting a Phone

The app detects whether a connected device is iOS or Android and uses the right toolchain automatically. Nothing is copied to your machine until you open or export a file.

### Android

Install the platform tools:

```bash
brew install --cask android-platform-tools
```

On the phone:

1. Enable **Developer options** (Settings → About phone → tap _Build number_ seven times).
2. Turn on **USB debugging** in Developer options.
3. Connect over USB and set the USB mode to **File Transfer (MTP)** rather than _Charging only_ — several manufacturers block adb in charge-only mode.
4. A prompt appears: **Allow USB debugging?** — tap **Allow**.

Until you tap Allow, the app shows the device as `unauthorized` with instructions. Browsing starts at `/sdcard`, which is your full user storage.

If the device still does not appear, check it from a terminal:

```bash
adb kill-server && adb devices -l
```

An empty list means macOS is not enumerating the phone at all — usually a charge-only cable, a hub, or USB debugging still switched off.

### iPhone / iPad

```bash
brew install libimobiledevice
```

That is the only requirement. The app talks the AFC protocol directly through `afcclient`, so **macFUSE and `ifuse` are not needed** — no kernel extension, no reduced-security mode, no reboot.

On the phone:

1. Connect over USB and unlock the device.
2. Tap **Trust This Computer** when prompted, then enter your passcode.

Press **Connect** in the app to pair. Nothing is mounted, and nothing is copied until you open or export a file.

> **iOS limitation:** Apple only exposes the media partition (DCIM, Photos, Downloads, Books, Recordings, and similar) over USB, even to a trusted computer. Full filesystem access is not available to any non-jailbroken tool. Android over `/sdcard` gives you considerably more.

If a required binary is missing, the app tells you exactly which one and the command to install it, rather than failing silently.

---

## Connecting Google Drive and Google Photos

### 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Open **APIs & Services → Library** and enable:
   - **Google Drive API**
   - **Google Photos Picker API**

### 2. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**.
2. Choose **External**, fill in the app name and your email.
3. On the **Scopes** step, add:

   | Scope                                                              | Purpose                    |
   | ------------------------------------------------------------------ | -------------------------- |
   | `https://www.googleapis.com/auth/drive`                            | Broad Drive read/write scope requested by this source snapshot |
   | `https://www.googleapis.com/auth/photospicker.mediaitems.readonly` | Read photos the user picks |

The scope above is broader than the current Files UI, which exposes no Google Drive write controls. The permission actually granted depends on the deployed OAuth project, consent configuration, and account; do not describe the OAuth grant itself as read-only based on the Files UI.

4. On the **Test users** step, add your own Google account.

Leaving the app in **Testing** mode is fine for personal use. Tokens expire after 7 days and you simply sign in again. Publishing requires Google verification because `drive` is a restricted scope.

### 3. Create credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**.
3. Copy the **Client ID** and **Client secret**.

### 4. Add them to `.env`

```bash
cp .env.example .env
```

```ini
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://127.0.0.1:3001/oauth/callback
```

`.env` is gitignored. For a packaged build, place `.env` in the app's userData directory instead
(`~/Library/Application Support/file-browser-electron/.env` on macOS).

Restart the app, then press **Connect Google account**. Sign-in uses the OAuth loopback flow with PKCE — your browser opens, you approve, and the app receives the code on `127.0.0.1`. Refresh tokens are stored in userData with `0600` permissions.

### Multiple accounts

Press **+** on the Google Accounts panel to add another account. Each sign-in shows Google's account chooser, so personal and work accounts can be connected at the same time.

- **All Drives** merges every connected account into one view, with a folder per account. Explode flattens all of them together.
- **All Photos** merges the photos picked from every account.
- Each account also has its own Drive and Photos shortcuts.

Accounts stay signed in across restarts. Access tokens refresh silently in the background; if a refresh token is revoked or expires, that account is flagged _Session expired — reconnect_ and the others keep working. Signing an account out revokes its token with Google rather than only forgetting it locally.

To confirm your credentials and scopes are set up correctly:

```bash
node scripts/verify-google.js
```

It prints the granted scopes and the live status of each API.

### What works, and what Google no longer allows

**Google Drive** — the current Files interface supports read-only browsing, folder navigation, previews, and streaming. It has no Google Drive create-folder, rename, move-to-trash, or upload controls. Generic **Move** and **New folder** controls are local filesystem actions and are unavailable on Google virtual paths. Google Docs, Sheets, and Slides are exported to PDF or PNG on the fly so they can be previewed. The source still requests a broader Drive OAuth scope and retains backend write handlers that the current Files renderer does not call; actual consent depends on the OAuth project and account.

**Google Photos** — read-only, and **only for photos the user explicitly picks**.

This is a platform restriction, not an app limitation. On **1 April 2025** Google removed the `photoslibrary.readonly`, `photoslibrary.sharing`, and `photoslibrary` scopes. Requests that relied on them now return `403 PERMISSION_DENIED`, so no application can browse a user's entire Photos library any more, regardless of what you enable in the Cloud Console.

The supported replacement is the **Picker API**, which this app uses:

1. Press **Pick from Google Photos**. The app creates a picker session and opens Google Photos.
2. You select the photos and videos you want to share.
3. The app polls the session, then loads your selection as a browsable folder.

Picked photos can then be searched, face-indexed, added to digital folders, and exported like any other file. Selections last for the session; use **Pick from Google Photos** again to choose a different set.

Editing Photos is limited to albums and media your app itself created (`photoslibrary.edit.appcreateddata`), which is why the app does not offer it.

---

## Project Structure

```
Silo/
├── src/
│   ├── main.ts             # Electron main process and IPC handlers
│   ├── phoneManager.ts     # iOS/Android detection, pairing, mounting, adb bridge
│   ├── googleManager.ts    # Google OAuth, Drive API, Photos Picker API
│   ├── semanticIndexer.ts  # Offline CLIP indexing and search
│   ├── faceIndexer.ts      # Face detection and clustering
│   ├── petIndexer.ts       # Pet photo clustering
│   ├── timeMachine.ts      # Time Machine snapshot parsing
│   ├── stateStore.ts       # Persisted UI state, digital folders, name index
│   ├── App.tsx             # Main React component
│   └── App.css             # App styles
├── public/
│   ├── index.html
│   └── preload.js          # Context-isolated bridge (the live preload)
├── scripts/
│   └── verify-google.js    # OAuth and scope diagnostic
├── .env.example
└── tsconfig.json
```

### How remote sources work

Phone and cloud files are addressed with virtual paths:

```
/__phone__/ios/<udid>/<path>
/__phone__/android/<serial>/<path>
/__cloud__/gdrive/<accountId>/<fileId>/<name>
/__cloud__/gphotos/<accountId>/<itemId>/<name>
```

Handlers in `main.ts` recognise these prefixes and resolve them on demand — `afcclient get` for iOS, `adb pull` for Android, an authenticated download for Google — caching the result in userData. Everything downstream treats them as ordinary files, which is why explode, thumbnails, digital folders, and semantic search work identically across every source.

iOS directory listings batch every `info` call into a single `afcclient` session over stdin, so a folder of a thousand photos costs one process rather than a thousand.

## Security Notes

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- All external commands use `execFile` with argument arrays; remote paths are shell-quoted, so filenames cannot inject commands
- OAuth uses PKCE with a `state` parameter, and tokens are written with `0600`
- Media is served through a privileged `app-media://` scheme rather than exposing the filesystem to the renderer
- `.env`, tokens, caches, and mounts are all gitignored

## Technologies Used

- **Electron** — desktop application framework
- **React** + **TypeScript** — UI
- **@huggingface/transformers** — offline CLIP embeddings
- **@vladmandic/face-api** + **TensorFlow.js** — face detection
- **libimobiledevice / afcclient** — iOS pairing and AFC file access
- **adb** — Android device bridge
- **Google Drive API v3** and **Google Photos Picker API**
