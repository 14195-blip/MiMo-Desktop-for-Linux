# MiMo AI for Linux

Unofficial native Linux builds of **Xiaomi MiMo AI**, produced by repackaging
Xiaomi's official Windows installer (an Electron/NSIS app) into a Linux
Electron build.

> **Not affiliated with or endorsed by Xiaomi.** MiMo AI is a trademark of its
> respective owner. This project repackages publicly distributed binaries for
> interoperability and personal use. Use it at your own risk; you are
> responsible for complying with MiMo AI's own terms of service and with any
> licence covering the upstream application.

Releases ship two architectures, each as a `.deb` and a portable `.tar.gz`:

| | x64 | arm64 |
|---|---|---|
| `.deb` | `…-linux-x64-amd64.deb` | `…-linux-arm64-arm64.deb` |
| portable | `…-linux-x64.tar.gz` | `…-linux-arm64.tar.gz` |

Grab the one matching your architecture from the
[releases page](https://github.com/14195-blip/MiMo-Desktop-for-Linux/releases).

## Install the .deb

```sh
sudo apt install ./XiaomiMiMo-AI-latest-x64-linux-x64-amd64.deb
```

That installs to `/opt/mimo-ai`, puts `xiaomi-mimo-ai` on your `PATH` and drops
a menu entry in your application list. Then:

```sh
xiaomi-mimo-ai
```

Or launch **Xiaomi MiMo AI** from your desktop's application menu.

The first screen is a Xiaomi account sign-in; Google sign-in also works. Your
profile lives in `~/.config/Xiaomi MiMo AI/` and survives rebuilds, so
upgrading never logs you out.

## Install the portable build

```sh
tar xzf XiaomiMiMo-AI-latest-x64-linux-x64.tar.gz
cd XiaomiMiMo-AI-latest-x64-linux-x64
./mimo.sh
```

The directory is self-contained and relocatable — move or rename it and the
launcher still works. For a menu entry, copy `mimo.desktop` to
`~/.local/share/applications/`.

## Build it yourself

You need `curl`, `npm`, `unzip`, `tar`, 7-Zip and — for `--deb` — `dpkg-deb`.
`mimo-bootstrap.sh` installs any that are missing (apt or Termux `pkg`) along
with Deno itself:

```sh
./mimo-bootstrap.sh --target-arch x64 --deb -y
```

Useful flags:

| flag | meaning |
|---|---|
| `--target-arch x64\|arm64` | which Linux arch to build (default `x64`) |
| `--deb` | also produce a `.deb` |
| `-y`, `--yes` | skip the destructive-operation prompts (required for CI) |
| `--exe-url URL` | build from a specific installer instead of the default |
| `--electron VER` | pin an Electron version instead of auto-detecting it |
| `--keep-work` | keep the scratch directory for debugging |

The build downloads roughly 200 MB of upstream installer plus a matching
Electron zip, and the output lands in `<exe-base>-linux-<arch>/` in the current
directory. Expect it to take a few minutes.

### What it actually does

1. Downloads the Windows `.exe` (or uses one you supply) and extracts the NSIS
   payload with 7-Zip.
2. Reads the bundled Electron version out of the Windows binary and fetches the
   matching **Linux** Electron build for your target arch.
3. Repacks `app.asar`, keeping native modules unpacked.
4. Re-fetches the native `.node`/`.so` modules npm stripped from the Windows
   package, resolving the variant that matches the *target* architecture.
5. Drops anything belonging to another platform — the Windows payload ships
   ~63 MiB of win32 (and some macOS) natives that can never load on Linux.
6. Writes a relocatable `mimo.sh` launcher and a `.desktop` entry.

## Continuous builds

The workflow builds x64 and arm64 in parallel, runs the script's unit tests as
a gate, and **rebuilds every Monday**. Scheduled runs never publish — they
exist so that upstream breakage shows up as a red build instead of a surprise
months later. To cut a release, dispatch the workflow manually with
`make_release` checked.

Available inputs:

| input | purpose |
|---|---|
| `exe_url` | installer URL; only if Xiaomi moves the CDN path |
| `electron_version` | pin an Electron version (blank = auto-detect) |
| `make_release` | publish a GitHub Release with the artifacts |

## Known limitations

- **No auto-update.** The upstream update configuration points at a Windows CDN,
  so it is deliberately not shipped. Reinstall to upgrade. (An
  `electron-updater` dependency is present, so a Linux updater is possible — it
  just isn't configured.)
- **glibc only.** musl/Alpine is intentionally skipped; the build fetches the
  `-gnu` native modules.
- **Sign-in uses a self-signed loopback certificate.** The app serves its OAuth
  callback from `https://127.0.0.1:<random-port>` with a certificate generated
  at runtime and never installed into any trust store, so your browser will warn
  before completing the redirect. This is upstream behaviour, not something
  this repack can fix from the outside.
- The `.deb` depends on the CJK/emoji font packages (`fonts-noto-cjk` and
  friends) because the app bundles no fonts of its own. They are declared
  dependencies, so `apt` pulls them in.

## Credits

* **MiMo AI** — © Xiaomi. The application code, assets and services are theirs.
* **Electron / Chromium** — MIT, BSD-3-Clause and other permissive licences; the
  full third-party licence text ships inside every build as
  `LICENSES.chromium.html`.
* The two scripts in this repository are covered by [LICENSE](LICENSE); see also
  [NOTICE](NOTICE).
