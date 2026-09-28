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

That installs to `/opt/mimo-ai`, puts `mimo-desktop` on your `PATH` and drops
a menu entry in your application list. Then:

```sh
mimo-desktop
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

The workflow builds x64 and arm64 in parallel and runs four jobs:

| job | what it does |
|---|---|
| `test` | `deno test`, which also type-checks the script |
| `build` | produces the portable tree and `.deb` for both arches |
| `smoke` | installs the real `.deb` in clean containers and launches it |
| `drift` | weekly only: files an issue if upstream moved |

`smoke` runs against **Ubuntu 22.04 and 25.10** — the two distros this build is
verified on — and it does the things that have actually broken before: install
the real `.deb` in a clean container, check every shared library resolves
(`ldd`, because the loader only ever reports the *first* missing one), check
the CJK font resolves to Noto rather than DejaVu, check `chrome-sandbox`
ended up setuid, and confirm the app reaches its local API listener with no
native-module error.

The build runs automatically **every Monday**. Scheduled runs never publish —
they exist so upstream breakage shows up as a red build instead of a surprise
months later. To cut a release, dispatch the workflow manually with
`make_release` checked. Releases are tagged with the upstream version
(`v26.924.240030`), so the tag is directly comparable to what the app reports.

Available inputs:

| input | purpose |
|---|---|
| `exe_url` | installer URL; only if Xiaomi moves the CDN path |
| `electron_version` | pin an Electron version (blank = auto-detect) |
| `make_release` | publish a GitHub Release with the artifacts |

## Known limitations

- **Runs where?** Verified by the CI smoke job on **Ubuntu 22.04 and 25.10**.
  It does **not** run on **24.04 or 25.04**, which fail at startup with:

  ```
  electron: symbol lookup error: undefined symbol: snd_device_name_get_hint, version ALSA_0.9
  ```

  That is Electron 41 against Ubuntu's `libasound2t64`, and it is not a
  packaging problem — the library is present and resolves, it just lacks a
  symbol version the binary needs. Oddly it is not monotonic in the alsa-lib
  version: 22.04 (alsa-lib 1.2.6.1) works and 25.10 (1.2.14) works, while
  24.04 (1.2.11) and 25.04 do not, so there is no honest version constraint
  to put in `Depends`. Fixing it would mean shipping a private `libasound`,
  which we are not doing. If you are on 24.04, upgrade to 25.10.
- **No auto-update, and it cannot be fixed from here.** The app does ship an
  `electron-updater` dependency and a per-platform update manager, but on Linux
  that manager only activates when `APPIMAGE` is set in the environment, and
  the feed URL it checks is fetched at runtime from MiMo's own remote config
  rather than from anything in the package. A directory or `.deb` install
  therefore never checks for updates, and no `app-update.yml` we could ship
  would change that — the app overrides the feed URL itself. Reinstall to
  upgrade.
- **Runs unsandboxed by default.** The `.deb` does set up Chromium's setuid
  sandbox helper, but a working sandbox also needs kernel namespace support
  that containers, PRoot and some VMs lack — there it aborts the process
  outright. Since "no sandbox" beats "does not start", the sandbox is opt-in:

  ```sh
  MIMO_SANDBOX=1 mimo-desktop
  ```

  On an ordinary Linux desktop this should work and is worth using.
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

* **Maintainer** — ShinZero <yousef2010.mahmoud@gmail.com>.
* **MiMo AI** — © Xiaomi. The application code, assets and services are theirs.
* **Electron / Chromium** — MIT, BSD-3-Clause and other permissive licences; the
  full third-party licence text ships inside every build as
  `LICENSES.chromium.html`.
* The two scripts in this repository are covered by [LICENSE](LICENSE); see also
  [NOTICE](NOTICE).
