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
 * this script. See also .github/workflows/build-mimo-linux.yml for a fully
 * automated x64 + arm64 + .deb build.
 */
import $ from "jsr:@david/dax@^0.50.0";
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
// Generic Electron runtime deps on Debian/Ubuntu. Best-effort, not verified —
// dpkg-deb won't check these actually resolve on the target system, so tune
// this if `apt install ./*.deb` complains about unmet dependencies.
const DEB_DEPENDS = [
  "libgtk-3-0",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0",
  "libuuid1",
  "libsecret-1-0",
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
    await $`tar -xzf ${join(tmp, tgz.name)}`.cwd(tmp).quiet();
    const dest = join(destRoot, destName);
    await Deno.mkdir(dest, { recursive: true });
    // package/* -> dest/
    await $`cp -r ${join(tmp, "package")}/. ${dest}/`.quiet();
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
  await $`cp -a ${outDir}/. ${pkgOptDir}/`.quiet();

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

  const debPath = `${outDir}-${debArch}.deb`;
  // dpkg-deb reports *why* it refused on stderr. dax captures that into the
  // ShellError and only surfaces the exit code, which turns a real diagnosis
  // ("path too long", "control file has bad permissions", ...) into a bare
  // "Exited with code: 1". Keep the command quiet on success, but print its
  // output when it fails so the cause is visible in CI logs.
  const built = await $`dpkg-deb --build --root-owner-group ${stageDir} ${debPath}`
    .noThrow();
  if (built.code !== 0) {
    const detail = `${built.stdout}${built.stderr}`.trim();
    console.error(`dpkg-deb --build failed (exit ${built.code}) for ${stageDir}`);
    if (detail) console.error(detail);
    Deno.exit(1);
  }
  await Deno.remove(stageDir, { recursive: true });
  console.log(`      wrote ${debPath}`);
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
  await $`unzip -o -q ${zipPath} -d ${outDir}`.quiet();

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
      if (!name.includes("linux")) continue; // only platform backfills here
      if (name.includes("musl")) continue; // glibc systems use the non-musl build
      if (await exists(join(nmDir, name, "package.json"))) continue;
      const ver = declared.get(name)!;
      console.log(`      fetching declared ${name}@${ver}...`);
      await npmFetch(`${name}@${ver}`, name, nmDir);
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
        await $`tar -xzf ${join(tmp, tgz.name)}`.cwd(tmp).quiet();
        await Deno.mkdir(dest, { recursive: true });
        const srcArch = join(tmp, "package/bin/napi-v6/linux", arch);
        await $`cp -r ${srcArch}/. ${dest}/`.quiet();
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

  // ---------------------------------------------------------------------------
  // 6+7. repack app.asar + regenerate app.asar.unpacked
  // ---------------------------------------------------------------------------
  console.log("[6/8] repacking app.asar...");
  const resDir = join(outDir, "resources");
  const newAsar = join(resDir, "app.asar");
  await createPackageWithOptions(srcDir, newAsar, { unpack: UNPACK_GLOB });
  const header = JSON.parse(getRawHeader(newAsar).headerString);
  const unpackedDir = join(resDir, "app.asar.unpacked");
  let total = 0, copied = 0;
  const missing: string[] = [];
  walkHeader(header, "", (p, e) => {
    if (!e.unpacked) return;
    total++;
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
    `[7/8] unpacked: ${copied}/${total}` +
      (missing.length ? ` (skipped, other-platform: ${missing.length})` : ""),
  );
  const appUpdate = join(appDir, "resources", "app-update.yml");
  if (await exists(appUpdate)) {
    await Deno.copyFile(appUpdate, join(resDir, "app-update.yml"));
  }

  // ---------------------------------------------------------------------------
  // 8. relocatable launcher + desktop file (both live INSIDE the build dir;
  // nothing is written anywhere else)
  // ---------------------------------------------------------------------------
  console.log("[8/8] writing launcher...");
  await Deno.writeTextFile(
    join(outDir, "mimo.sh"),
    `#!/usr/bin/env bash
# Generated by mimo-linux.ts — do not hand-edit (re-run the script instead).
# Resolves everything relative to its own location, so this directory stays
# runnable after being moved or renamed.
HERE="$(cd "$(dirname "$0")" && pwd)"
# Unset APPIMAGE: AppImage terminals (e.g. Zap) leak it into every child,
# and the app mistakes a foreign APPIMAGE for its own install path.
unset APPIMAGE APPDIR
export TMPDIR="$HERE/tmp"
mkdir -p "$TMPDIR"
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
           in-app updates target Windows builds — ignore update prompts.`);

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

Deno.test("BUILTINS covers node: and bare forms", () => {
  for (const m of ["fs", "node:fs", "node:timers/promises", "worker_threads"]) {
    if (!BUILTINS.has(m)) throw new Error(`missing ${m}`);
  }
  if (BUILTINS.has("react")) throw new Error("react must not be builtin");
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
