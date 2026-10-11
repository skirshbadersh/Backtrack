// Packs the project exactly as `npm publish` would, installs the tarball into an
// empty directory, and runs the installed CLI the way `npx` would. Fails loudly if
// the package is missing files (dist, web) or the bin does not start.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "bt-pack-"));
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const step = (msg) => console.log(`• ${msg}`);

try {
  step("npm pack (runs prepack → build)");
  const tarball = JSON.parse(sh("npm", ["pack", "--json", "--pack-destination", work], root))[0];
  const files = tarball.files.map((f) => f.path);
  for (const required of ["dist/cli.js", "dist/server/serve.js", "dist/sdk/index.js", "web/index.html", "web/app.js", "web/app.css"]) {
    if (!files.includes(required)) throw new Error(`package is missing ${required}`);
  }
  for (const f of files) if (/^(src|test|e2e|docs|node_modules)\//.test(f)) throw new Error(`package should not ship ${f}`);
  step(`${tarball.filename}: ${files.length} files, ${(tarball.size / 1024).toFixed(0)} kB`);

  const app = join(work, "app");
  sh("mkdir", ["-p", app]);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-smoke", private: true }));
  step("install the tarball into an empty project (no dev dependencies)");
  sh("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", join(work, tarball.filename)], app);
  const deps = readdirSync(join(app, "node_modules")).filter((d) => !d.startsWith("."));
  if (deps.length !== 1) throw new Error(`expected zero runtime dependencies, found: ${deps.join(", ")}`);

  step("npx bt-demo --help");
  if (!sh("npx", ["--no-install", "bt-demo", "--help"], app).includes("Usage:")) throw new Error("help did not print");

  step("npx bt-demo demo (offline sandbox, exits 0 only if every guarantee held)");
  sh("npx", ["--no-install", "bt-demo", "demo"], app);

  step("npx bt-demo serve, then fetch the UI and the API");
  // Own process group, so killing it also stops the node process npx starts.
  const server = spawn("npx", ["--no-install", "bt-demo", "serve", "--port", "0"], { cwd: app, detached: true });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("serve did not start")), 15000);
      server.stdout.on("data", (d) => {
        const m = /Review UI: (\S+)/.exec(String(d));
        if (m) (clearTimeout(timer), resolve(m[1]));
      });
      server.on("exit", (code) => reject(new Error(`serve exited with ${code}`)));
    });
    step(`server up at ${url}`);
    for (const path of ["", "app.css", "app.js", "api/state"]) {
      const res = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`GET /${path} → ${res.status}`);
    }
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  console.log("pack smoke test passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
