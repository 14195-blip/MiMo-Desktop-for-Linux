#!/usr/bin/env -S deno run -A
/**
 * mimo-linux.ts — turn Xiaomi's Windows-only MiMo AI installer (.exe, NSIS)
 * into a working native Linux (Electron) build, for x64 or arm64, optionally
 * packaged as a .deb.
 *
 * Pipeline:
 *   0. (new) Auto-download the installer .exe if it's missing on disk.
 *   1. Extract NSIS archive      (7z)          -> app-64.7z
 *   2. Extract app payload        (7z)          -> Electron dist + app.asar
 *   3. Detect bundled Electron version          -> download matching linux build
 *      for the requested --target-arch (x64 or arm64 — independent of the
 *      host running this script; only downloads differ, nothing is compiled).
 *   4. Extract app.asar          (@electron/asar CLI, tolerates stripped files)
 *   5. Fetch missing linux-native npm packages (pinned versions from package.json
 *      optionalDependencies, e.g. *-linux-<arch>-*) + pinned extras (node-machine-id)
 *      + onnxruntime-node's bundled linux/<arch> native binaries.
 *   6. Repack app.asar           (@electron/asar API, binaries stay unpacked)
 *   7. Regenerate app.asar.unpacked from the new header
 *   8. Write relocatable launcher (mimo.sh) + mimo.desktop inside the
 *      build dir (absolute paths, copy the .desktop to
 *      ~/.local/share/applications only if you want a menu entry).
 *      Nothing is written outside the build dir.
 *   9. (new, --deb) Package the build into a .deb for --target-arch, installed
 *      at a fixed /opt/mimo-ai path with a /usr/bin symlink + .desktop entry.
 *
 * Usage:
 *   deno run -A mimo-linux.ts [/path/to/XiaomiMiMo-AI-*-setup.exe] [--out DIR]
 *                              [--target-arch x64|arm64] [--deb] [--exe-url URL] [...]
 *
 *   The exe path is now optional: if omitted, or if the given path doesn't
 *   exist yet, it's downloaded automatically from --exe-url. The installer's
 *   JS payload (app.asar) is architecture-independent — only the Electron
 *   shell and a handful of native npm modules differ per arch — so the same
 *   Windows x64 installer is a valid source for both --target-arch x64 and
 *   --target-arch arm64 builds.
 *
 * Output defaults to a portable dir in the current working directory
 * (<exe-base>-linux-<arch>/), runnable in place or movable.
 * Only dependency besides system tools (7z, curl, npm, unzip, tar, and
 * dpkg-deb if --deb is used) is JSR+Dax/npm resolved automatically on first run
 *
 * Bootstrapping (Deno itself, 7z, dpkg-deb, ...) on a fresh machine or CI:
 * see mimo-bootstrap.sh, which installs whatever's missing and then calls
 * this script. See also .github/workflows/main.yml for a fully automated
 * x64 + arm64 + .deb build (unit tests, scheduled rebuilds, releases).
 */
import $, { type CommandBuilder } from "jsr:@david/dax@^0.50.0";
import {
  createPackageWithOptions,
  extractFile,
  getRawHeader,
  listPackage,
  statFile,
} from "npm:@electron/asar@^4.3.0";
import { basename, dirname, join } from "jsr:@std/path@^1.1.6";
import { builtinModules } from "node:module";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const ELECTRON_BASE = "https://github.com/electron/electron/releases/download";
// Default source installer. The payload is arch-independent JS, so this one
// installer is used as the source for every --target-arch build.
const DEFAULT_EXE_URL =
  "https://mimocode-cdn.xiaomimimo.com/mimocode/mimodesktopai/XiaomiMiMo-AI-latest-x64-setup.exe";
// Pure-JS deps the bundle requires at runtime but the Windows installer omits
// from every platform (version -> pinned known-good, since package.json has
// no entry to read the version from).
const PINNED_EXTRAS: Record<string, string> = {
  "node-machine-id": "1.1.12",
};
// Single minimatch (matchBase) for files that must stay OUTSIDE app.asar.
// NOTE: @electron/asar accepts ONE pattern — multiple --unpack flags silently
// keep only the last one.
const UNPACK_GLOB = "*.{node,dll,exe,dylib,dat,so,so.*}";
// Node builtins in both "fs" and "node:fs" forms must not be treated as npm deps.
const BUILTINS = new Set(
  builtinModules.flatMap((m) => [
    m,
    m.startsWith("node:") ? m.slice("node:".length) : `node:${m}`,
  ]),
);
// Debian's own arch names differ from the ones electron/npm use.
const DEB_ARCH: Record<TargetArch, string> = { x64: "amd64", arm64: "arm64" };
// dpkg >= 1.22 defaults to zstd, which is fast but measurably bigger than xz
// on this payload (same tree: 150.5 MB as zstd vs 133.6 MB as xz -9, ~11%).
// xz -9 costs a few minutes of wall clock per arch at build time.
const DEB_COMPRESSION = "xz";
const DEB_COMPRESSION_LEVEL = "9";
// Electron ships ~56 locale .pak files. MiMo is Chinese + English and Electron
// falls back to en-US.pak for anything it can't find, so the rest (~44 MiB,
// mostly ml/ta/kn/te/hi/bn) is dead weight. Add codes here to ship more.
const KEEP_LOCALES = ["en-US", "zh-CN", "zh-TW"];
// Generic Electron runtime deps on Debian/Ubuntu. Best-effort, not verified —
// dpkg-deb won't check these actually resolve on the target system, so tune
// this if `apt install ./*.deb` complains about unmet dependencies.
const DEB_DEPENDS = [
  // "a | b" alternatives: Ubuntu 24.04+ renamed these to *-t64 (the t64
  // packages also Provide the old names, but spelling out both keeps the
  // deb installable on old and new distros without relying on that).
  "libgtk-3-0 | libgtk-3-0t64",
  "libatspi2.0-0 | libatspi2.0-0t64",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libuuid1",
  "libsecret-1-0",
  // The app bundles no fonts whatsoever (0 .ttf/.otf in the whole tree), so
  // every glyph comes from the system. On a minimal install fontconfig's
  // default sans-serif resolves to DejaVu, which has no CJK coverage, and a
  // Chinese-first UI renders as tofu boxes.
  "fontconfig",
  "fonts-dejavu-core",
  "fonts-noto-cjk",
  "fonts-noto-color-emoji",
].join(", ");

type TargetArch = "x64" | "arm64";

interface Opts {
  exe: string;
  exeUrl: string;
  out: string;
  work: string;
  electron: string | null;
  targetArch: TargetArch;
  deb: boolean;
  keepWork: boolean;
  yes: boolean;
  verbose: boolean;
}

function usage(): never {
  console.error(`Usage:
  deno run -A mimo-linux.ts [SETUP.exe] [options]

If SETUP.exe is omitted, or the path doesn't exist yet, it's downloaded
automatically (see --exe-url).

Options:
  --out DIR           output dir (default: <exe-base>-linux-<arch>/ in cwd)
  --work DIR          scratch dir (default: ~/dev/tmp/mimo-port)
  --electron VER      linux Electron version (default: detected from the exe)
  --target-arch ARCH  x64 or arm64 (default: this host's arch)
  --deb               also package the build as a .deb for --target-arch
  --exe-url URL       installer URL to auto-download when missing
                       (default: ${DEFAULT_EXE_URL})
  --keep-work         don't delete scratch dir afterwards
  -y, --yes           skip deletion/download confirmation prompts (automation)
  --verbose           show unresolvable-import diagnostics
  -h, --help          this text`);
  Deno.exit(2);
}

function parseArgs(args: string[]): Opts {
  const home = Deno.env.get("HOME") ?? "/root";
  const o: Opts = {
    exe: "",
    exeUrl: DEFAULT_EXE_URL,
    out: "",
    work: join(home, "dev/tmp/mimo-port"),
    electron: null,
    targetArch: archName(Deno.build.arch) as TargetArch,
    deb: false,
    keepWork: false,
    yes: false,
    verbose: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") o.out = args[++i];
    else if (a === "--work") o.work = args[++i];
    else if (a === "--electron") o.electron = args[++i];
    else if (a === "--target-arch") {
      const v = args[++i];
      if (v !== "x64" && v !== "arm64") {
        console.error(`--target-arch must be x64 or arm64, got: ${v}`);
        Deno.exit(2);
      }
      o.targetArch = v;
    } else if (a === "--deb") o.deb = true;
    else if (a === "--exe-url") o.exeUrl = args[++i];
    else if (a === "--keep-work") o.keepWork = true;
    else if (a === "-y" || a === "--yes") o.yes = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "-h" || a === "--help") usage();
    else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`);
      usage();
    } else rest.push(a);
  }
  if (rest.length > 1) usage();
  o.exe = rest[0] ?? ""; // may be empty -> auto-download
  return o;
}

async function need(tool: string) {
  // Use dax's own `$.which` instead of shelling out to `command -v`.
  // dax does not delegate to bash: it is a pure-JS shell whose builtin set is
  // cd/printenv/echo/cat/exit/export/set/shopt/sleep/test/rm/mkdir/cp/mv/pwd/
  // touch/unset/which — there is no `command` builtin. So `$\`command -v x\``
  // resolves "command" as an ordinary executable, finds no binary by that name,
  // and exits non-zero no matter which tool is being probed — which made this
  // function report *every* tool as missing (curl, npm, ...) even on a runner
  // where all of them were installed. `$.which` does the PATH lookup directly.
  const found = await $.which(tool);
  if (found == null) {
    console.error(`missing required tool: ${tool}`);
    Deno.exit(1);
  }
}

// Run a command with its output kept out of the log, but print what the tool
// actually said when it fails. dax swallows a failed command's output into the
// result and surfaces only the exit code, and `.quiet()` (no argument) silences
// *both* streams — so a failure otherwise shows up as a bare
// "ShellError: Exited with code: 1" with no cause at all.
async function run(label: string, cmd: CommandBuilder): Promise<void> {
  const res = await cmd.noThrow().quiet();
  if (res.code === 0) return;
  const detail = `${res.stdout}${res.stderr}`.trim();
  console.error(`${label}: failed with exit code ${res.code}`);
  if (detail) console.error(detail);
  Deno.exit(1);
}

// True for native binaries that belong to a platform we are not building for.
// The source is a *Windows* installer, so its app.asar.unpacked is full of
// win32 natives (onnxruntime.dll, skia.win32-*.node, a second icudtl.dat,
// node-pty's conpty/OpenConsole.exe, parcel watcher) — ~63 MiB that can never
// load on Linux and used to be copied straight into the Linux build. The
// matching linux-*-gnu natives are fetched from npm earlier in the run.
// Matched on substrings because npm platform packages embed the platform in
// the package name ("@napi-rs/canvas-win32-x64-msvc"), not as a path segment.
function isForeignPlatform(relPath: string): boolean {
  const s = relPath.toLowerCase();
  if (s.includes("win32") || s.includes("darwin") || s.includes("-musl")) {
    return true;
  }
  return /\.(dll|exe|dylib)$/.test(s);
}

// npm platform package names embed the target: "…-linux-x64[-variant]".
const PLATFORM_PKG =
  /-linux-(x64|arm64|ia32|armv7l|armv6l|ppc64le|s390x|mips64el|riscv64)(?=-|$)/;

// Map a declared linux platform package onto the arch we are building.
// The Windows payload only ever declares (and leaves an empty dir for) the
// x64 variant, so filtering on the declared name alone finds nothing for an
// arm64 build — it has to *ask* npm for e.g. @parcel/watcher-linux-arm64-glibc.
// Returns null when the name is not a linux platform package.
function archVariant(name: string, arch: TargetArch): string | null {
  if (name.includes("musl")) return null;
  if (!PLATFORM_PKG.test(name)) return null;
  return name.replace(PLATFORM_PKG, `-linux-${arch}`);
}

// Pick a version that actually exists for `spec`: the one the payload
// declares if that exact version is published for this arch, otherwise
// whatever npm currently serves. Platform variants normally share the
// declared version, but not always.
async function resolveVersion(spec: string, declaredVer?: string) {
  if (declaredVer) {
    const r = await $`npm view ${spec}@${declaredVer} version`.noThrow().quiet();
    if (r.code === 0 && r.stdout.trim()) return declaredVer;
  }
  const r = await $`npm view ${spec} version`.noThrow().quiet();
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`no version of ${spec} is available on npm`);
  }
  return r.stdout.trim().split("\n").pop()!.trim();
}

// Refuse to build if a platform native for a *different* architecture is
// installed under node_modules. The first arm64 release shipped three x64
// .node binaries this way and the app died on startup with "Cannot find
// native binding" — the build itself was green, so nothing else caught it.
async function assertNativesMatchArch(nmDir: string, arch: TargetArch) {
  const wrong: string[] = [];
  const scan = async (dir: string, prefix: string) => {
    const entries: Deno.DirEntry[] = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
    for (const e of entries) {
      if (!e.isDirectory) continue;
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.name.startsWith("@")) {
        await scan(join(dir, e.name), name);
        continue;
      }
      if (!PLATFORM_PKG.test(e.name)) continue;
      if (e.name.includes(`-linux-${arch}-`) || e.name.endsWith(`-linux-${arch}`)) {
        continue;
      }
      // only a real install counts; the Windows payload leaves empty dirs
      // behind for every platform it stripped, and those are harmless
      if (await exists(join(dir, e.name, "package.json"))) wrong.push(name);
    }
  };
  await scan(nmDir, "");
  if (wrong.length === 0) return;
  console.error(
    `error: node_modules contains platform natives for the wrong architecture ` +
      `(building for linux-${arch}):`,
  );
  for (const w of wrong) console.error(`  ${w}`);
  console.error("these .node files cannot load here; fix the fetch filter.");
  Deno.exit(1);
}

// A .node/.so is an ELF object on Linux. The Windows payload occasionally
// carries a macOS build too — @parcel/watcher/build/Release/watcher.node is a
// Mach-O arm64 bundle whose path mentions neither win32 nor darwin, so the
// name-based filter above cannot see it. Nothing can dlopen it here.
async function isForeignBinary(p: string): Promise<boolean> {
  if (!/\.(node|so|so\.\d+)$/.test(p)) return false;
  const f = await Deno.open(p, { read: true });
  try {
    const head = new Uint8Array(4);
    const n = await f.read(head);
    const isElf = n === 4 && head[0] === 0x7f && head[1] === 0x45 &&
      head[2] === 0x4c && head[3] === 0x46;
    return !isElf;
  } catch {
    return false; // unreadable: leave it, do not silently delete payload
  } finally {
    f.close();
  }
}

// Remove foreign-platform natives from a finished app.asar.unpacked tree and
// collapse the directories that end up empty. Needed because @electron/asar's
// createPackage writes every `unpack`-matching file into <dest>.unpacked
// itself — filtering our own re-copy afterwards is too late to help.
async function pruneForeignNatives(dir: string) {
  let files = 0, bytes = 0;
  const entries: Deno.DirEntry[] = [];
  for await (const e of Deno.readDir(dir)) entries.push(e);
  const subdirs: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory) {
      subdirs.push(p);
      const r = await pruneForeignNatives(p);
      files += r.files;
      bytes += r.bytes;
    } else if (isForeignPlatform(p) || await isForeignBinary(p)) {
      bytes += (await Deno.stat(p)).size;
      await Deno.remove(p);
      files++;
    }
  }
  // deepest first, so a chain of emptied parents collapses in one pass
  for (const d of subdirs.reverse()) {
    try {
      if ([...Deno.readDirSync(d)].length === 0) await Deno.remove(d);
    } catch { /* not empty, or already gone */ }
  }
  return { files, bytes };
}

// Drop every locale .pak except KEEP_LOCALES (Electron falls back to en-US).
async function pruneLocales(installDir: string) {
  const dir = join(installDir, "locales");
  if (!await exists(dir)) return;
  let dropped = 0, bytes = 0;
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".pak")) continue;
    if (KEEP_LOCALES.includes(e.name.replace(/\.pak$/, ""))) continue;
    const p = join(dir, e.name);
    bytes += (await Deno.stat(p)).size;
    await Deno.remove(p);
    dropped++;
  }
  if (dropped) {
    console.log(
      `      locales: kept ${KEEP_LOCALES.join(", ")} — dropped ${dropped} ` +
        `(${(bytes / 1048576).toFixed(1)} MiB)`,
    );
  }
}

// Resolve a working 7-Zip binary. On Ubuntu 24.04+ ("noble", incl. the
// GitHub-hosted ubuntu-latest runner), `p7zip-full` is a transitional dummy
// package (upstream p7zip is unmaintained) that no longer installs a `7z`
// binary — it just pulls in the `7zip` package, whose binary is `7zz`.
// Accept either name so this doesn't hard-fail on distros that already made
// the switch, without requiring a symlink to be set up beforehand.
let sevenZipBin = "";
async function findSevenZip(): Promise<string> {
  for (const candidate of ["7z", "7zz", "7zzs"]) {
    // `$.which`, not `command -v` — see the note in need() above.
    if (await $.which(candidate) != null) return candidate;
  }
  console.error(
    "missing required tool: 7z (also checked for 7zz)\n" +
      "On Ubuntu 24.04+, `p7zip-full` is a transitional package that no " +
      "longer provides a `7z` binary — install `7zip` instead " +
      "(sudo apt-get install 7zip), or symlink 7zz -> 7z.",
  );
  return Deno.exit(1);
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Prompt before a destructive filesystem operation (or a network fetch the
// user hasn't explicitly asked for). --yes skips; non-interactive stdin
// refuses (automation must opt in explicitly).
function confirmDestructive(message: string, yes: boolean) {
  if (yes) return;
  let ok = false;
  try {
    ok = confirm(message);
  } catch {
    ok = false;
  }
  if (!ok) {
    console.error("aborted (re-run with --yes to skip this prompt)");
    Deno.exit(1);
  }
}

// Make sure a real installer file exists on disk, downloading it from
// opts.exeUrl first if opts.exe is empty or the given path doesn't exist yet.
// Returns the resolved path.
async function ensureExe(opts: Opts): Promise<string> {
  const home = Deno.env.get("HOME") ?? "/root";
  let name: string;
  try {
    name = basename(new URL(opts.exeUrl).pathname) || "mimo-setup.exe";
  } catch {
    console.error(`--exe-url is not a valid URL: ${opts.exeUrl}`);
    Deno.exit(2);
  }
  const dest = opts.exe || join(home, "dev/tmp/mimo-dl", name);
  if (await exists(dest)) return dest;

  confirmDestructive(
    `installer not found locally:\n  ${dest}\nwill download it from:\n  ${opts.exeUrl}\ncontinue?`,
    opts.yes,
  );
  await Deno.mkdir(dirname(dest), { recursive: true });
  console.log(`[download] fetching installer from ${opts.exeUrl} ...`);
  await $`curl -L -C - --retry 20 --retry-all-errors --retry-delay 5 --retry-max-time 0 --progress-bar -o ${dest} ${opts.exeUrl}`;
  return dest;
}

// Scan a (large) binary for the Electron version stamp without loading it
// fully into memory: "Chrome/146.0.7680.216 Electron/41.7.2".
async function detectElectronVersion(exePath: string): Promise<string> {
  const f = await Deno.open(exePath, { read: true });
  const chunk = new Uint8Array(8 * 1024 * 1024);
  let tail = "";
  const re = /Electron\/(\d+\.\d+\.\d+)/;
  try {
    while (true) {
      const n = await f.read(chunk);
      if (n === null) break;
      const text = tail +
        new TextDecoder("latin1").decode(chunk.subarray(0, n));
      const m = re.exec(text);
      if (m) return m[1];
      tail = text.slice(-64);
    }
  } finally {
    f.close();
  }
  throw new Error("could not detect Electron version (use --electron)");
}

// Bare `require("x")` / `from"x"` specifiers referenced by the bundle.
async function findBareImports(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  const re = /(?:require\(\s*|from\s*)["']([A-Za-z0-9@][A-Za-z0-9@/_.-]*)["']/g;
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".mjs")) continue;
    const src = await Deno.readTextFile(join(dir, e.name));
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/") || spec === "electron") {
        continue;
      }
      if (!BUILTINS.has(spec) && !spec.startsWith("node:")) found.add(spec);
    }
  }
  return found;
}

function topLevel(spec: string): string {
  return spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
}

export function archName(buildArch: string): string {
  return buildArch === "aarch64" ? "arm64" : "x64";
}

/** Fail fast on obviously-bad installer files (empty, truncated, wrong type). */
export async function preflightExe(path: string): Promise<void> {
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(path);
  } catch {
    throw new Error(`exe not found: ${path}`);
  }
  if (!st.isFile) throw new Error(`not a file: ${path}`);
  if ((st.size ?? 0) < 1024 * 1024) {
    throw new Error(
      `exe is only ${st.size} bytes (a full installer is ~250MB) — re-download it: ${path}`,
    );
  }
  const f = await Deno.open(path, { read: true });
  try {
    const head = new Uint8Array(2);
    if ((await f.read(head)) !== 2 || head[0] !== 0x4d || head[1] !== 0x5a) {
      throw new Error(`not a Windows executable (missing MZ header): ${path}`);
    }
  } finally {
    f.close();
  }
}

// "<exe-base>-linux-<arch>" directory name, e.g.
// XiaomiMiMo-AI-latest-x64-setup.exe, arch=arm64 ->
//   XiaomiMiMo-AI-latest-x64-linux-arm64
// (the arch suffix was added so x64 and arm64 builds from the same exe don't
// clobber each other's output dir).
export function portableName(exeAbs: string, arch: TargetArch = "x64"): string {
  const base = basename(exeAbs)
    .replace(/-?setup\.exe$/i, "")
    .replace(/\.exe$/i, "");
  return `${base}-linux-${arch}`;
}

async function npmFetch(spec: string, destName: string, destRoot: string) {
  const tmp = await Deno.makeTempDir();
  try {
    try {
      await $`npm pack --silent --pack-destination ${tmp} ${spec}`
        .printCommand()
        .quiet("stdout");
    } catch (e) {
      throw new Error(
        `npm pack failed for ${spec} (network/registry issue): ${
          (e as Error).message
        }`,
      );
    }
    const tgz = [...Deno.readDirSync(tmp)].find((e) =>
      e.isFile && e.name.endsWith(".tgz")
    );
    if (!tgz) throw new Error(`npm pack produced no tarball for ${spec}`);
    await run(`tar -xzf (${spec})`, $`tar -xzf ${join(tmp, tgz.name)}`.cwd(tmp));
    const dest = join(destRoot, destName);
    await Deno.mkdir(dest, { recursive: true });
    // package/* -> dest/
    await run(`cp -r (${spec} -> ${destName})`, $`cp -r ${join(tmp, "package")}/. ${dest}/`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

interface HeaderNode {
  files?: Record<string, HeaderNode>;
  size?: number;
  unpacked?: boolean;
  offset?: string;
}

function walkHeader(
  node: HeaderNode,
  rel: string,
  cb: (path: string, e: HeaderNode) => void,
) {
  for (const [name, e] of Object.entries(node.files ?? {})) {
    const p = rel ? `${rel}/${name}` : name;
    if (e.files) walkHeader(e, p, cb);
    else cb(p, e);
  }
}

// Harvest version declarations from every package.json in a node_modules
// tree (used to backfill platform packages the installer stripped).
async function collectDecls(
  dir: string,
  depth: number,
  declared: Map<string, string>,
) {
  if (depth > 4) return;
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory || e.name.startsWith(".")) continue;
    const pj = join(dir, e.name, "package.json");
    try {
      const meta = JSON.parse(await Deno.readTextFile(pj));
      for (
        const bag of [
          meta.optionalDependencies,
          meta.dependencies,
          meta.peerDependencies,
        ]
      ) {
        for (const [n, v] of Object.entries(bag ?? {})) {
          if (typeof v === "string" && !declared.has(n)) declared.set(n, v);
        }
      }
    } catch { /* no package.json */ }
    await collectDecls(join(dir, e.name), depth + 1, declared);
  }
}

// Find installed dirs missing package.json (the extractor leaves those as
// empty dirs for stripped platform packages).
async function findMissingPkgs(
  dir: string,
  prefix: string,
  declared: Map<string, string>,
  wants: string[],
) {
  for await (const e of Deno.readDir(dir)) {
    if (!e.isDirectory || e.name.startsWith(".")) continue;
    const name = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.name.startsWith("@")) {
      await findMissingPkgs(join(dir, e.name), name, declared, wants);
      continue;
    }
    if (
      !await exists(join(dir, e.name, "package.json")) && declared.has(name)
    ) {
      wants.push(name);
    }
  }
}

// ---------------------------------------------------------------------------
// .deb packaging
// ---------------------------------------------------------------------------

// Recursive copy that preserves permissions, symlinks and timestamps — i.e.
// what `cp -a` was being used for when staging the .deb payload. Done with
// plain Deno APIs instead of shelling out, because dax implements `cp` as a
// builtin that only understands -r/-R/--recursive and rejects -a outright
// ("cp: unsupported flag: -a"), and Deno.cp is still gated behind an unstable
// flag on some Deno 2.x releases. Everything used here (lstat/readDir/mkdir/
// copyFile/symlink/chmod/utime) is stable.
async function copyTree(src: string, dest: string): Promise<void> {
  const st = await Deno.lstat(src);
  if (st.isDirectory) {
    await Deno.mkdir(dest, { recursive: true });
    for await (const entry of Deno.readDir(src)) {
      await copyTree(join(src, entry.name), join(dest, entry.name));
    }
    // mkdir applies the umask, so put the source mode back explicitly.
    if (st.mode != null) await Deno.chmod(dest, st.mode & 0o7777);
  } else if (st.isSymlink) {
    await Deno.symlink(await Deno.readLink(src), dest);
  } else {
    // copyFile carries the permissions over, so the executable bit on
    // `electron` and `mimo.sh` survives into the package.
    await Deno.copyFile(src, dest);
    const mtime = st.mtime ?? new Date();
    await Deno.utime(dest, st.atime ?? mtime, mtime);
  }
}

async function buildDeb(
  outDir: string,
  arch: TargetArch,
  version: string,
  yes: boolean,
) {
  const debArch = DEB_ARCH[arch];
  console.log(`[deb] building .deb (${debArch})...`);
  const pkgName = "xiaomi-mimo-ai";
  const installRoot = "/opt/mimo-ai";
  const stageDir = `${outDir}.deb-stage`;

  if (await exists(stageDir)) {
    confirmDestructive(
      `deb staging dir exists and will be DELETED:\n  ${stageDir}\ncontinue?`,
      yes,
    );
    await Deno.remove(stageDir, { recursive: true });
  }
  const pkgOptDir = join(stageDir, "opt", "mimo-ai");
  const pkgBinDir = join(stageDir, "usr", "bin");
  const pkgAppsDir = join(stageDir, "usr", "share", "applications");
  const pkgDebianDir = join(stageDir, "DEBIAN");
  for (const d of [pkgOptDir, pkgBinDir, pkgAppsDir, pkgDebianDir]) {
    await Deno.mkdir(d, { recursive: true });
  }

  // Copy the whole portable build tree in as-is: electron binary, resources/
  // (app.asar + app.asar.unpacked), mimo.sh, icon.png, mimo.desktop.
  await copyTree(outDir, pkgOptDir);

  // mimo.sh locates itself via "$(dirname "$0")", so it works unmodified
  // from /opt/mimo-ai too — just put it on PATH.
  const binLink = join(pkgBinDir, pkgName);
  try {
    await Deno.remove(binLink);
  } catch { /* not there */ }
  await Deno.symlink(join(installRoot, "mimo.sh"), binLink);

  // .desktop needs the FINAL install path, not the build dir's — write a
  // fresh one (same identity as the portable one, different Exec/Icon).
  await Deno.writeTextFile(
    join(pkgAppsDir, `${pkgName}.desktop`),
    `[Desktop Entry]
Name=Xiaomi MiMo AI
Comment=AI coding assistant desktop client (community Linux port)
Exec=${installRoot}/mimo.sh %U
Icon=${installRoot}/icon.png
Type=Application
Terminal=false
Categories=Development;
StartupWMClass=xiaomi-mimo-ai
StartupNotify=true
`,
  );

  const debVersion = /^[0-9][\w.+~-]*$/.test(version) ? version : "0.0.0";
  await Deno.writeTextFile(
    join(pkgDebianDir, "control"),
    `Package: ${pkgName}
Version: ${debVersion}
Section: utils
Priority: optional
Architecture: ${debArch}
Depends: ${DEB_DEPENDS}
Maintainer: Unofficial Port <noreply@example.com>
Description: Unofficial Linux (Electron) port of Xiaomi MiMo AI
 Repackaged from the official Windows installer by mimo-linux.ts.
 Not affiliated with or endorsed by Xiaomi. Adjust Depends in this script
 if "apt install ./*.deb" reports unmet dependencies on your distro.
`,
  );

  // Chromium's setuid sandbox helper has to be mode 4755 root:root, or the
  // app can only ever run with --no-sandbox. A zip cannot carry the setuid
  // bit, so the file arrives as 0755 — which matters because the app
  // registers its own custom protocol against the electron binary directly,
  // bypassing mimo.sh and its --no-sandbox. Without this, the deep link that
  // should hand a sign-in token back to the app cannot start the app.
  const postinst = join(pkgDebianDir, "postinst");
  await Deno.writeTextFile(
    postinst,
    `#!/bin/sh
set -e
sandbox=${installRoot}/chrome-sandbox
if [ -f "$sandbox" ]; then
  chown root:root "$sandbox" 2>/dev/null || true
  chmod 4755 "$sandbox" 2>/dev/null || true
fi
exit 0
`,
  );
  await Deno.chmod(postinst, 0o755);

  const debPath = `${outDir}-${debArch}.deb`;
  // dpkg-deb says *why* it refused on stderr; run() surfaces that on failure.
  await run(
    `dpkg-deb --build (${basename(debPath)})`,
    $`dpkg-deb --build -Z ${DEB_COMPRESSION} -z ${DEB_COMPRESSION_LEVEL} --root-owner-group ${stageDir} ${debPath}`,
  );
  await Deno.remove(stageDir, { recursive: true });
  console.log(
    `      wrote ${debPath} (${
      ((await Deno.stat(debPath)).size / 1048576).toFixed(1)
    } MiB, ${DEB_COMPRESSION}-${DEB_COMPRESSION_LEVEL})`,
  );
}

// ---------------------------------------------------------------------------
// main (only when run directly — `deno test` runs the tests below instead)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const opts = parseArgs(Deno.args);
  const requiredTools = ["curl", "npm", "unzip", "tar"];
  if (opts.deb) requiredTools.push("dpkg-deb");
  for (const t of requiredTools) await need(t);
  sevenZipBin = await findSevenZip();

  opts.exe = await ensureExe(opts);
  try {
    await preflightExe(opts.exe);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    Deno.exit(1);
  }
  // Default output: portable dir in the CURRENT working directory,
  // "<exe-base>-linux-<arch>" (e.g. XiaomiMiMo-AI-latest-x64-setup.exe,
  // --target-arch arm64 -> ./XiaomiMiMo-AI-latest-x64-linux-arm64).
  if (!opts.out) {
    const absExe = await Deno.realPath(opts.exe);
    opts.exe = absExe;
    opts.out = join(Deno.cwd(), portableName(absExe, opts.targetArch));
  }
  const work = opts.work;
  const extractDir = join(work, "nsis");
  const appDir = join(work, "app"); // raw windows payload
  const srcDir = join(work, "src"); // extracted app.asar + linux natives
  const outDir = opts.out;
  const arch = opts.targetArch; // independent of the host running this script

  console.log(
    `exe:  ${opts.exe}\nout:  ${outDir}\nwork: ${work}\narch: ${arch}` +
      (opts.deb ? ` (+ .deb for ${DEB_ARCH[arch]})` : ""),
  );

  // ---------------------------------------------------------------------------
  // 0. scratch dirs
  // ---------------------------------------------------------------------------
  if (await exists(work)) {
    confirmDestructive(
      `scratch dir exists and will be DELETED:\n  ${work}\ncontinue?`,
      opts.yes,
    );
    await Deno.remove(work, { recursive: true });
  }
  for (const d of [extractDir, appDir, srcDir]) {
    await Deno.mkdir(d, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // 1+2. NSIS -> app-*.7z -> windows payload
  // ---------------------------------------------------------------------------
  console.log("[1/8] extracting NSIS archive...");
  await $`${sevenZipBin} x -tNsis ${opts.exe} -o${extractDir}`.quiet("stdout");
  const plugindir = join(extractDir, "$PLUGINSDIR");
  let inner7z = "";
  for await (const e of Deno.readDir(plugindir)) {
    if (e.isFile && /^app-.*\.7z$/.test(e.name)) {
      if (e.name === "app-64.7z") {
        inner7z = join(plugindir, e.name);
        break;
      }
      inner7z ||= join(plugindir, e.name);
    }
  }
  if (!inner7z) throw new Error("app-*.7z not found in NSIS archive");
  console.log(`[2/8] extracting payload ${basename(inner7z)}...`);
  await $`${sevenZipBin} x ${inner7z} -o${appDir}`.quiet("stdout");
  const asarPath = join(appDir, "resources", "app.asar");
  if (!await exists(asarPath)) throw new Error("resources/app.asar missing");

  // ---------------------------------------------------------------------------
  // 3. detect/download linux Electron for --target-arch
  // ---------------------------------------------------------------------------
  let largestExe = "", largestSize = -1;
  for await (const e of Deno.readDir(appDir)) {
    if (e.isFile && e.name.toLowerCase().endsWith(".exe")) {
      const st = await Deno.stat(join(appDir, e.name));
      if (st.size > largestSize) {
        largestSize = st.size;
        largestExe = join(appDir, e.name);
      }
    }
  }
  const ev = opts.electron ?? await detectElectronVersion(largestExe);
  console.log(`[3/8] electron ${ev} (linux-${arch})`);
  const zipName = `electron-v${ev}-linux-${arch}.zip`;
  const zipUrl = `${ELECTRON_BASE}/v${ev}/${zipName}`;
  const zipPath = join(work, zipName);
  await $`curl -L -C - --retry 20 --retry-all-errors --retry-delay 5 --retry-max-time 0 --progress-bar -o ${zipPath} ${zipUrl}`;
  await $`unzip -t ${zipPath}`.quiet("stdout");
  console.log("      zip verified");

  // ---------------------------------------------------------------------------
  // install dir (only now that downloads succeeded) + unzip electron
  // ---------------------------------------------------------------------------
  if (await exists(outDir)) {
    const bak = `${outDir}.bak.${Date.now()}`;
    confirmDestructive(
      `output dir exists and will be MOVED ASIDE:\n  ${outDir}\n  -> ${bak}\ncontinue?`,
      opts.yes,
    );
    console.log(`      backing up existing install -> ${bak}`);
    await Deno.rename(outDir, bak);
  }
  await Deno.mkdir(outDir, { recursive: true });
  console.log("[4/8] unpacking electron...");
  await run(
    `unzip -o -q (${zipName})`,
    $`unzip -o -q ${zipPath} -d ${outDir}`,
  );
  // Electron's fallback app: only used when resources/app.asar is missing,
  // which can't happen here. Every other Electron packager strips it.
  const defaultApp = join(outDir, "resources", "default_app.asar");
  if (await exists(defaultApp)) await Deno.remove(defaultApp);
  await pruneLocales(outDir);

  // ---------------------------------------------------------------------------
  // 5. extract app.asar + fetch missing linux natives
  // ---------------------------------------------------------------------------
  console.log("[5/8] extracting app.asar...");
  {
    // NB: the asar CLI aborts on unpacked-files the Windows installer stripped,
    // so extract per-file and skip what's absent (other-platform natives).
    // Links are re-created, dirs via parents.
    const files = listPackage(asarPath, { isPack: false }) as string[];
    let ok = 0, skipped = 0;
    for (const f of files) {
      // NB: the asar API wants paths WITHOUT leading "/" (its splitter
      // chokes on them); listPackage returns them WITH.
      const rel = f.replace(/^\/+/, "");
      const dest = join(srcDir, rel);
      try {
        const buf = extractFile(asarPath, rel) as Uint8Array;
        await Deno.mkdir(dirname(dest), { recursive: true });
        await Deno.writeFile(dest, buf);
        ok++;
      } catch {
        // dirs + links land here (extractFile only does real files);
        // anything else is a stripped unpacked file -> skip.
        try {
          const st = statFile(asarPath, rel, false) as unknown as {
            link?: string;
            files?: unknown;
          };
          await Deno.mkdir(dirname(dest), { recursive: true });
          if (st && typeof st === "object" && "files" in st) {
            await Deno.mkdir(dest, { recursive: true });
            ok++;
          } else if (st && typeof st.link === "string") {
            try {
              await Deno.remove(dest);
            } catch { /* not there */ }
            await Deno.symlink(st.link.replace(/^\/+/, srcDir + "/"), dest);
            ok++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
    }
    console.log(`      extracted ${ok} files, skipped ${skipped} (stripped)`);
  }
  const pkg = JSON.parse(await Deno.readTextFile(join(srcDir, "package.json")));
  const nmDir = join(srcDir, "node_modules");
  const optDeps: Record<string, string> = pkg.optionalDependencies ?? {};
  for (const [name, ver] of Object.entries(optDeps)) {
    if (
      name.includes(`linux-${arch}`) && !name.includes("musl") &&
      // NB: the extractor leaves EMPTY dirs for stripped packages, so a
      // directory check is not enough — require package.json.
      !await exists(join(nmDir, name, "package.json"))
    ) {
      console.log(`      fetching ${name}@${ver}...`);
      await npmFetch(`${name}@${ver}`, name, nmDir);
    }
  }
  // diagnostic: report anything still unresolvable (usually renderer-only strings).
  for (const spec of await findBareImports(join(srcDir, "out", "main"))) {
    const top = topLevel(spec);
    if (top in PINNED_EXTRAS) continue;
    if (await exists(join(nmDir, top, "package.json"))) continue;
    if (opts.verbose) {
      console.warn(
        `      WARN: unresolvable import "${spec}" (not installed; may be renderer-only)`,
      );
    }
  }
  // bundle references that resolve to nothing (e.g. node-machine-id, which the
  // windows installer omits on every platform). The bundle wraps require() in a
  // minified loader, so match the literal quoted name instead of import syntax.
  for (const [name, ver] of Object.entries(PINNED_EXTRAS)) {
    if (await exists(join(nmDir, name, "package.json"))) continue;
    let referenced = false;
    for await (const e of Deno.readDir(join(srcDir, "out", "main"))) {
      if (!e.isFile || !e.name.endsWith(".mjs")) continue;
      const src = await Deno.readTextFile(join(srcDir, "out", "main", e.name));
      if (src.includes(`"${name}"`) || src.includes(`'${name}'`)) {
        referenced = true;
        break;
      }
    }
    if (referenced) {
      console.log(`      fetching pinned extra ${name}@${ver}...`);
      await npmFetch(`${name}@${ver}`, name, nmDir);
    }
  }
  // repair pass: some platform packages (e.g. @parcel/watcher-linux-x64-glibc)
  // are declared by a SIBLING package already in the tree, not by the root
  // package.json. Harvest every declaration found in-tree and fill dirs that
  // are missing package.json (the extractor leaves those as empty dirs).
  {
    const declared = new Map<string, string>();
    await collectDecls(nmDir, 0, declared);
    const wants: string[] = [];
    await findMissingPkgs(nmDir, "", declared, wants);
    for (const name of wants) {
      // The Windows payload declares (and leaves an empty dir for) every
      // platform it shipped — in practice the win32 and x64 variants. Fetch
      // the variant for the arch we are actually building: the first arm64
      // release shipped three *x64* .node files and the app died on startup
      // with "Cannot find native binding", while the build stayed green.
      const target = archVariant(name, arch);
      if (target == null) continue;
      if (await exists(join(nmDir, target, "package.json"))) continue;
      const ver = await resolveVersion(
        target,
        declared.get(target) ?? declared.get(name),
      );
      console.log(`      fetching declared ${target}@${ver}...`);
      await npmFetch(`${target}@${ver}`, target, nmDir);
    }
  }
  // onnxruntime-node ships ALL platform binaries inside the single package
  // (bin/napi-v6/<os>/<arch>); the installer strips non-windows ones.
  {
    const onnxPkg = join(nmDir, "onnxruntime-node/package.json");
    const dest = join(nmDir, "onnxruntime-node/bin/napi-v6/linux", arch);
    if (
      await exists(onnxPkg) &&
      !await exists(join(dest, "onnxruntime_binding.node"))
    ) {
      const ver = JSON.parse(await Deno.readTextFile(onnxPkg)).version;
      console.log(`      fetching onnxruntime-node@${ver} linux binaries...`);
      const tmp = await Deno.makeTempDir();
      try {
        try {
          await $`npm pack --silent --pack-destination ${tmp} onnxruntime-node@${ver}`
            .quiet("stdout");
        } catch (e) {
          throw new Error(
            `npm pack failed for onnxruntime-node@${ver}: ${
              (e as Error).message
            }`,
          );
        }
        const tgz = [...Deno.readDirSync(tmp)].find((e) =>
          e.name.endsWith(".tgz")
        )!;
        await run(
          `tar -xzf (onnxruntime-node@${ver})`,
          $`tar -xzf ${join(tmp, tgz.name)}`.cwd(tmp),
        );
        await Deno.mkdir(dest, { recursive: true });
        const srcArch = join(tmp, "package/bin/napi-v6/linux", arch);
        await run(
          `cp -r (onnxruntime-node linux/${arch} -> ${dest})`,
          $`cp -r ${srcArch}/. ${dest}/`,
        );
        const srcShared = join(tmp, "package/bin/napi-v6/linux");
        for await (const e of Deno.readDir(srcShared)) {
          if (e.isFile) {
            await Deno.copyFile(
              join(srcShared, e.name),
              join(dest, "..", e.name),
            );
          }
        }
      } finally {
        await Deno.remove(tmp, { recursive: true });
      }
    }
  }
  await assertNativesMatchArch(nmDir, arch);

  // ---------------------------------------------------------------------------
  // 6+7. repack app.asar + regenerate app.asar.unpacked
  // ---------------------------------------------------------------------------
  console.log("[6/8] repacking app.asar...");
  const resDir = join(outDir, "resources");
  const newAsar = join(resDir, "app.asar");
  await createPackageWithOptions(srcDir, newAsar, { unpack: UNPACK_GLOB });
  const header = JSON.parse(getRawHeader(newAsar).headerString);
  const unpackedDir = join(resDir, "app.asar.unpacked");
  let total = 0, copied = 0, foreign = 0;
  const missing: string[] = [];
  walkHeader(header, "", (p, e) => {
    if (!e.unpacked) return;
    total++;
    if (isForeignPlatform(p)) {
      foreign++;
      return;
    }
    const s = join(srcDir, p), d = join(unpackedDir, p);
    try {
      Deno.mkdirSync(dirname(d), { recursive: true });
      Deno.copyFileSync(s, d);
      copied++;
    } catch {
      missing.push(p);
    }
  });
  console.log(
    `[7/8] unpacked: re-copied ${copied}/${total}` +
      (foreign ? ` (not re-copied, foreign-platform: ${foreign})` : "") +
      (missing.length ? ` (skipped, other-platform: ${missing.length})` : ""),
  );
  // …but createPackage already wrote every one of those foreign files into
  // app.asar.unpacked, so the re-copy filter above changes nothing on disk.
  // Sweep the finished tree for real.
  {
    const swept = await pruneForeignNatives(unpackedDir);
    if (swept.files) {
      console.log(
        `      swept ${swept.files} foreign-platform files ` +
          `(${(swept.bytes / 1048576).toFixed(1)} MiB) from app.asar.unpacked`,
      );
    }
  }
  // NB: deliberately NOT copying the installer's app-update.yml. It points at
  // the Windows CDN (provider: generic, url: .../mimodesktopai/), so on Linux
  // the auto-updater would go looking for Windows installers. Leaving it out
  // disables the updater, which is what we want on a repack.

  // ---------------------------------------------------------------------------
  // 8. relocatable launcher + desktop file (both live INSIDE the build dir;
  // nothing is written anywhere else)
  // ---------------------------------------------------------------------------
  console.log("[8/8] writing launcher...");
  await Deno.writeTextFile(
    join(outDir, "mimo.sh"),
    `#!/usr/bin/env bash
# Generated by mimo-linux.ts — do not hand-edit (re-run the script instead).
# Resolves everything relative to its own real location, so this directory
# stays runnable after being moved or renamed.
#
# readlink -f matters: the .deb puts a symlink at /usr/bin/xiaomi-mimo-ai
# pointing here, and \`$0\` is the path the caller *typed*, not the file it
# resolves to. A plain \`dirname "$0"\` therefore computes HERE=/usr/bin and
# then fails looking for /usr/bin/electron.
HERE="$(cd -P "$(dirname "$(readlink -f "$0")")" && pwd)"
# Unset APPIMAGE: AppImage terminals (e.g. Zap) leak it into every child,
# and the app mistakes a foreign APPIMAGE for its own install path.
unset APPIMAGE APPDIR
# Keep scratch files beside the app when we can (a portable build in a
# user-owned directory), otherwise fall back to a per-user runtime dir. A
# .deb install sits in root-owned /opt, and an unwritable TMPDIR makes
# Chromium's cache and session writes fail — which is one way auth tokens
# end up lost after a sign-in that actually succeeded in the browser.
if mkdir -p "$HERE/tmp" 2>/dev/null && [ -w "$HERE/tmp" ]; then
  export TMPDIR="$HERE/tmp"
else
  export TMPDIR="\${XDG_RUNTIME_DIR:-/tmp}/mimo-ai-$(id -u)"
  mkdir -p "$TMPDIR" 2>/dev/null || export TMPDIR=/tmp
fi
exec "$HERE/electron" --no-sandbox "$@"
`,
  );
  await Deno.chmod(join(outDir, "mimo.sh"), 0o755);
  const iconSrc = join(srcDir, "assets", "icon.png");
  const iconDst = join(outDir, "icon.png");
  if (await exists(iconSrc)) await Deno.copyFile(iconSrc, iconDst);
  await Deno.writeTextFile(
    join(outDir, "mimo.desktop"),
    `[Desktop Entry]
Name=Xiaomi MiMo AI
Comment=AI coding assistant desktop client (community Linux port)
Exec=${join(outDir, "mimo.sh")} %U
Icon=${iconDst}
Type=Application
Terminal=false
Categories=Development;
StartupWMClass=xiaomi-mimo-ai
StartupNotify=true
`,
  );

  // ---------------------------------------------------------------------------
  // done
  // ---------------------------------------------------------------------------
  if (!opts.keepWork) await Deno.remove(work, { recursive: true });
  console.log(`\ndone: ${outDir}
  run:     ./mimo.sh   (from inside that directory)
  menu:    copy mimo.desktop to ~/.local/share/applications/ (optional)
  profile: ~/.config/"Xiaomi MiMo AI"/   (kept across rebuilds)
  notes:   first screen is Xiaomi-account login (Google works);
           the Windows updater config is not shipped, so the app never
           self-updates — reinstall to upgrade.`);

  // ---------------------------------------------------------------------------
  // 9. (optional) package as .deb for --target-arch
  // ---------------------------------------------------------------------------
  if (opts.deb) {
    await buildDeb(outDir, arch, pkg.version ?? "0.0.0", opts.yes);
  }
} // end import.meta.main

// ---------------------------------------------------------------------------
// inline tests: `deno test -A mimo-linux.ts`
// ---------------------------------------------------------------------------

Deno.test("parseArgs: exe positional + defaults", () => {
  const o = parseArgs(["/tmp/x-setup.exe"]);
  if (o.exe !== "/tmp/x-setup.exe") throw new Error("exe");
  if (o.out !== "") throw new Error("out should be empty until resolved");
  if (o.electron !== null || o.keepWork !== false) throw new Error("defaults");
  if (o.deb !== false) throw new Error("deb should default false");
  if (o.exeUrl !== DEFAULT_EXE_URL) throw new Error("exeUrl default");
});

Deno.test("parseArgs: exe omitted -> empty (auto-download)", () => {
  const o = parseArgs([]);
  if (o.exe !== "") throw new Error("exe should default empty");
});

Deno.test("parseArgs: flags", () => {
  const o = parseArgs([
    "a.exe",
    "--out",
    "/tmp/o",
    "--work",
    "/tmp/w",
    "--electron",
    "41.7.2",
    "--keep-work",
    "--yes",
    "--verbose",
  ]);
  if (o.out !== "/tmp/o") throw new Error("out");
  if (o.work !== "/tmp/w") throw new Error("work");
  if (o.electron !== "41.7.2") throw new Error("electron");
  if (!o.keepWork) throw new Error("keepWork");
  if (!o.yes) throw new Error("yes");
  if (!o.verbose) throw new Error("verbose");
});

Deno.test("parseArgs: new flags (target-arch, deb, exe-url)", () => {
  const o = parseArgs([
    "--target-arch",
    "arm64",
    "--deb",
    "--exe-url",
    "https://example.com/setup.exe",
  ]);
  if (o.targetArch !== "arm64") throw new Error("targetArch");
  if (!o.deb) throw new Error("deb");
  if (o.exeUrl !== "https://example.com/setup.exe") throw new Error("exeUrl");
});

Deno.test("topLevel: scoped and bare specs", () => {
  const cases: [string, string][] = [
    ["@lydell/node-pty", "@lydell/node-pty"],
    ["@parcel/watcher/build/Release/x", "@parcel/watcher"],
    ["undici", "undici"],
    ["react-dom/server", "react-dom"],
  ];
  for (const [spec, want] of cases) {
    const got = topLevel(spec);
    if (got !== want) throw new Error(`${spec} -> ${got}, want ${want}`);
  }
});

Deno.test("portableName: setup suffix stripped, arch suffix added", () => {
  const got = portableName("/dl/XiaomiMiMo-AI-latest-x64-setup.exe", "x64");
  const want = "XiaomiMiMo-AI-latest-x64-linux-x64";
  if (got !== want) throw new Error(`${got} != ${want}`);
});

Deno.test("portableName: plain exe, arm64 target", () => {
  const got = portableName("/dl/tool.exe", "arm64");
  if (got !== "tool-linux-arm64") throw new Error(got);
});

Deno.test("archName mapping", () => {
  if (archName("x86_64") !== "x64") throw new Error("x86_64");
  if (archName("aarch64") !== "arm64") throw new Error("aarch64");
});

Deno.test("DEB_ARCH mapping", () => {
  if (DEB_ARCH.x64 !== "amd64") throw new Error("x64");
  if (DEB_ARCH.arm64 !== "arm64") throw new Error("arm64");
});

Deno.test("isForeignPlatform: drops win32/darwin/musl, keeps linux", () => {
  // these all shipped in the linux build before the filter existed
  for (const p of [
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
    "node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
    "node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat",
    "node_modules/@parcel/watcher-win32-x64/watcher.node",
    "node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe",
    "node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node",
    "node_modules/some-darwin-arm64/lib.dylib",
    "node_modules/@napi-rs/canvas-linux-x64-musvg/skia.linux-x64-musl.node",
  ]) {
    if (!isForeignPlatform(p)) throw new Error(`should be foreign: ${p}`);
  }
  // the linux natives we actually want must survive
  for (const p of [
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
    "node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node",
    "node_modules/@parcel/watcher-linux-x64-glibc/watcher.node",
    "out/main/node.mjs",
  ]) {
    if (isForeignPlatform(p)) throw new Error(`should be kept: ${p}`);
  }
});

Deno.test("BUILTINS covers node: and bare forms", () => {
  for (const m of ["fs", "node:fs", "node:timers/promises", "worker_threads"]) {
    if (!BUILTINS.has(m)) throw new Error(`missing ${m}`);
  }
  if (BUILTINS.has("react")) throw new Error("react must not be builtin");
});

Deno.test("archVariant: remaps declared x64 packages onto the target arch", () => {
  const cases: Array<[string, TargetArch, string | null]> = [
    ["@parcel/watcher-linux-x64-glibc", "arm64", "@parcel/watcher-linux-arm64-glibc"],
    ["@napi-rs/canvas-linux-x64-gnu", "arm64", "@napi-rs/canvas-linux-arm64-gnu"],
    ["@lydell/node-pty-linux-x64", "arm64", "@lydell/node-pty-linux-arm64"],
    ["@napi-rs/canvas-linux-arm64-gnu", "x64", "@napi-rs/canvas-linux-x64-gnu"],
    ["@napi-rs/canvas-linux-x64-musl", "arm64", null],
    ["onnxruntime-node", "arm64", null],
    ["@parcel/watcher-win32-x64-msvc", "arm64", null],
  ];
  for (const [name, arch, want] of cases) {
    const got = archVariant(name, arch);
    if (got !== want) throw new Error(`${name} -> ${got}, want ${want}`);
  }
});

Deno.test("pruneForeignNatives: removes win32 tree, keeps linux, collapses dirs", async () => {
  const root = await Deno.makeTempDir();
  try {
    const put = async (rel: string, data: string) => {
      const p = join(root, rel);
      await Deno.mkdir(dirname(p), { recursive: true });
      await Deno.writeTextFile(p, data);
    };
    // a realistic app.asar.unpacked: linux natives that must survive, and the
    // win32 leftovers @electron/asar writes on its own. The keepers carry real
    // ELF magic, because pruneForeignNatives sniffs the header, not the name.
    const ELF = "\x7fELF";
    await put("node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1", ELF);
    await put("node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll", "MZ");
    await put("node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node", ELF);
    await put("node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node", "MZ");
    await put("node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat", "x");
    await put("node_modules/@parcel/watcher-win32-x64/watcher.node", "MZ");
    await put("node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe", "MZ");
    // a macOS build whose path mentions no foreign platform: Mach-O magic
    await put("node_modules/@parcel/watcher/build/Release/watcher.node", "MH");

    const r = await pruneForeignNatives(root);
    if (r.files !== 6) throw new Error(`expected 6 swept, got ${r.files}`);

    const left: string[] = [];
    const walk = async (dir: string, prefix = "") => {
      const entries: Deno.DirEntry[] = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory) await walk(join(dir, e.name), rel);
        else left.push(rel);
      }
    };
    await walk(root);
    left.sort();
    const want = [
      "node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node",
      "node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1",
    ];
    if (left.join("|") !== want.join("|")) {
      throw new Error(`survivors: ${left.join("|")}`);
    }
    // the win32-only package dirs must be gone, not left empty
    for (
      const gone of [
        "node_modules/@napi-rs/canvas-win32-x64-msvc",
        "node_modules/@parcel/watcher-win32-x64",
        "node_modules/@lydell",
      ]
    ) {
      if (await exists(join(root, gone))) throw new Error(`left behind: ${gone}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("walkHeader: nested traversal", () => {
  const header: HeaderNode = {
    files: {
      "a.js": { size: 1 },
      dir: { files: { "b.node": { size: 2, unpacked: true } } },
    },
  };
  const seen: string[] = [];
  const unpacked: string[] = [];
  walkHeader(header, "", (p, e) => {
    seen.push(p);
    if (e.unpacked) unpacked.push(p);
  });
  if (seen.join(",") !== "a.js,dir/b.node") {
    throw new Error(`traversal: ${seen.join(",")}`);
  }
  if (unpacked.join(",") !== "dir/b.node") throw new Error("unpacked flag");
});

Deno.test("preflightExe: rejects empty file", async () => {
  const tmp = await Deno.makeTempFile();
  try {
    let threw = "";
    try {
      await preflightExe(tmp);
    } catch (e) {
      threw = (e as Error).message;
    }
    if (!threw.includes("only 0 bytes")) {
      throw new Error(`wrong error: ${threw}`);
    }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("preflightExe: rejects missing file", async () => {
  let threw = "";
  try {
    await preflightExe("/nonexistent-12345/setup.exe");
  } catch (e) {
    threw = (e as Error).message;
  }
  if (!threw.includes("not found")) throw new Error(`wrong error: ${threw}`);
});

Deno.test("preflightExe: rejects non-MZ header", async () => {
  const tmp = await Deno.makeTempFile();
  try {
    // big enough to pass the size gate, wrong magic
    await Deno.writeFile(tmp, new Uint8Array(2 * 1024 * 1024));
    let threw = "";
    try {
      await preflightExe(tmp);
    } catch (e) {
      threw = (e as Error).message;
    }
    if (!threw.includes("MZ header")) throw new Error(`wrong error: ${threw}`);
  } finally {
    await Deno.remove(tmp);
  }
});
