import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const installScript = path.join(repoRoot, "scripts", "install.sh");
const tempDirs: string[] = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-install-sh-"));
	tempDirs.push(dir);
	return dir;
}

function writeExecutable(file: string, content: string) {
	fs.writeFileSync(file, content);
	fs.chmodSync(file, 0o755);
}

function writeFixtureRepo(dir: string) {
	const packageDir = path.join(dir, "packages", "coding-agent");
	const nativesDir = path.join(dir, "packages", "natives");
	fs.mkdirSync(packageDir, { recursive: true });
	fs.mkdirSync(nativesDir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ private: true, workspaces: { packages: ["packages/*"] }, catalog: { zod: "4.0.0" } }),
	);
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			bin: { omp: "src/cli.ts" },
			dependencies: { zod: "catalog:" },
		}),
	);
	fs.writeFileSync(path.join(nativesDir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
}

function writeShims(dir: string) {
	const shimDir = path.join(dir, "shim");
	const stateDir = path.join(dir, "state");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	const gitShim = path.join(shimDir, "git");
	writeExecutable(
		gitShim,
		`#!/bin/sh
set -eu
printf 'git' >> "$OMP_INSTALL_TEST_LOG"
for arg do printf ' <%s>' "$arg" >> "$OMP_INSTALL_TEST_LOG"; done
printf '\n' >> "$OMP_INSTALL_TEST_LOG"
if [ "$1" = "clone" ]; then
  for dest do :; done
  mkdir -p "$dest"
  cp -R "$OMP_INSTALL_TEST_REPO_FIXTURE/." "$dest/"
  exit 0
fi
if [ "$1" = "checkout" ]; then exit 0; fi
if [ "$1" = "lfs" ] && [ "\${2:-}" = "pull" ]; then exit 0; fi
echo "unexpected git invocation: $*" >&2
exit 99
`,
	);
	writeExecutable(path.join(shimDir, "git-lfs"), "#!/bin/sh\nexit 0\n");

	const bunShim = path.join(shimDir, "bun");
	writeExecutable(
		bunShim,
		`#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  echo "1.3.14"
  exit 0
fi
printf 'bun' >> "$OMP_INSTALL_TEST_LOG"
for arg do printf ' <%s>' "$arg" >> "$OMP_INSTALL_TEST_LOG"; done
printf '\n' >> "$OMP_INSTALL_TEST_LOG"

cwd="$PWD"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cwd=*) cwd="\${1#--cwd=}"; shift ;;
    --cwd) shift; cwd="$1"; shift ;;
    *) break ;;
  esac
done
cmd="\${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

workspace_root() {
  dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -d "$dir/packages/coding-agent" ]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="\${dir%/*}"
    if [ -z "$dir" ]; then dir="/"; fi
  done
  return 1
}

is_source_path() {
  case "$1" in
    */packages/coding-agent|*/packages/coding-agent/) return 0 ;;
  esac
  [ -d "$1/packages/coding-agent" ]
}

case "$cmd" in
  install)
    if [ "\${1:-}" = "-g" ]; then
      target="\${2:-}"
      if is_source_path "$target"; then
        echo "simulated Bun catalog/workspace failure for direct global source install: $target" >&2
        exit 42
      fi
      echo "unexpected global install target: $target" >&2
      exit 99
    fi
    if [ "\${OMP_INSTALL_TEST_FAIL_INSTALL:-}" = "1" ]; then
      if [ "\${1:-}" != "--frozen-lockfile" ]; then
        echo "expected frozen lockfile install before simulated failure, got: $*" >&2
        exit 99
      fi
      echo "simulated dependency install failure" >&2
      exit 43
    fi
    root="$(workspace_root "$cwd")" || {
      echo "expected workspace install inside cloned repo, got cwd=$cwd" >&2
      exit 99
    }
    printf '%s' "$root" > "$OMP_INSTALL_TEST_STATE/workspace-installed"
    exit 0
    ;;
  run)
    [ -f "$OMP_INSTALL_TEST_STATE/workspace-installed" ] || {
      echo "native build attempted before workspace dependencies were installed" >&2
      exit 99
    }
    if [ "$cwd" != "$(workspace_root "$cwd")/packages/natives" ] || [ "\${1:-}" != "build" ]; then
      echo "unexpected bun run invocation in cwd=$cwd: $*" >&2
      exit 99
    fi
    exit 0
    ;;
  link)
    [ -f "$OMP_INSTALL_TEST_STATE/workspace-installed" ] || {
      echo "link attempted before workspace dependencies were installed" >&2
      exit 99
    }
    if [ "$#" -eq 0 ]; then
      target="$cwd"
    else
      case "$1" in
        /*) target="$1" ;;
        *) target="$cwd/$1" ;;
      esac
    fi
    case "$target" in
      */packages/coding-agent|*/packages/coding-agent/) ;;
      *)
        echo "expected coding-agent package link target, got $target" >&2
        exit 99
        ;;
    esac
    mkdir -p "$BUN_INSTALL/bin"
    printf '#!/bin/sh\necho installed-from-source\n' > "$BUN_INSTALL/bin/omp"
    chmod +x "$BUN_INSTALL/bin/omp"
    exit 0
    ;;
  *)
    echo "unexpected bun invocation: $cmd $*" >&2
    exit 99
    ;;
esac
`,
	);

	return { shimDir, stateDir };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("scripts/install.sh", () => {
	it("installs --source --ref from the cloned workspace instead of global-installing the package directory", () => {
		const dir = makeTempDir();
		const fixtureRepo = path.join(dir, "fixture-repo");
		const bunInstall = path.join(dir, "bun-install");
		const commandLog = path.join(dir, "commands.log");
		writeFixtureRepo(fixtureRepo);
		const { shimDir, stateDir } = writeShims(dir);

		const result = Bun.spawnSync(["sh", installScript, "--source", "--ref", "feature/source-install"], {
			cwd: dir,
			env: {
				...process.env,
				HOME: path.join(dir, "home"),
				BUN_INSTALL: bunInstall,
				OMP_INSTALL_TEST_LOG: commandLog,
				OMP_INSTALL_TEST_REPO_FIXTURE: fixtureRepo,
				OMP_INSTALL_TEST_STATE: stateDir,
				PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();

		expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("✓ Installed omp via bun");
		expect(fs.existsSync(path.join(bunInstall, "bin", "omp"))).toBe(true);
	});

	it("keeps the existing source checkout when reinstall dependency installation fails", () => {
		const dir = makeTempDir();
		const fixtureRepo = path.join(dir, "fixture-repo");
		const bunInstall = path.join(dir, "bun-install");
		const commandLog = path.join(dir, "commands.log");
		const sourceInstallRoot = path.join(dir, "source-installs");
		const ref = "feature/source-install";
		const existingSourceDir = path.join(sourceInstallRoot, "feature_source-install");
		const sentinel = path.join(existingSourceDir, "existing-sentinel.txt");
		const replacementMarker = "replacement-checkout-marker.txt";
		writeFixtureRepo(fixtureRepo);
		fs.writeFileSync(path.join(fixtureRepo, replacementMarker), "new checkout");
		fs.mkdirSync(existingSourceDir, { recursive: true });
		fs.writeFileSync(sentinel, "existing checkout");
		const { shimDir, stateDir } = writeShims(dir);

		const result = Bun.spawnSync(["sh", installScript, "--source", "--ref", ref], {
			cwd: dir,
			env: {
				...process.env,
				HOME: path.join(dir, "home"),
				BUN_INSTALL: bunInstall,
				PI_SOURCE_INSTALL_DIR: sourceInstallRoot,
				OMP_INSTALL_TEST_FAIL_INSTALL: "1",
				OMP_INSTALL_TEST_LOG: commandLog,
				OMP_INSTALL_TEST_REPO_FIXTURE: fixtureRepo,
				OMP_INSTALL_TEST_STATE: stateDir,
				PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();

		expect(result.exitCode, `${stdout}\n${stderr}`).toBe(1);
		expect(stdout).toContain("Failed to install source dependencies");
		expect(stderr).toContain("simulated dependency install failure");
		expect(fs.existsSync(sentinel)).toBe(true);
		expect(fs.readFileSync(sentinel, "utf8")).toBe("existing checkout");
		expect(fs.existsSync(path.join(existingSourceDir, replacementMarker))).toBe(false);
	});
});
