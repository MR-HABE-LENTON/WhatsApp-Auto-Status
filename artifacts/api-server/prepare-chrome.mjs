import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const PUPPETEER_PKG = path.resolve(
  "/home/runner/workspace/node_modules/.pnpm/puppeteer@24.40.0_typescript@5.9.3/node_modules/puppeteer"
);
const cacheDir = path.join(os.homedir(), ".cache", "puppeteer");
const chromeDir = path.join(cacheDir, "chrome");

// ─── Clean stale lock files ───────────────────────────────────────────────────

function cleanChromeLocks() {
  try {
    const userDataDir = path.join(process.cwd(), ".wwebjs_auth");
    if (existsSync(userDataDir)) {
      try {
        execSync(
          `find "${userDataDir}" -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" | xargs rm -f`,
          { stdio: "pipe" }
        );
        console.log("[prepare-chrome] Cleaned stale Chrome lock files.");
      } catch {
        // ignore — files may not exist
      }
    }
  } catch (err) {
    console.warn("[prepare-chrome] Could not clean locks:", err.message);
  }
}

cleanChromeLocks();

// ─── Check cache ──────────────────────────────────────────────────────────────

let chromeFound = false;

if (existsSync(chromeDir)) {
  try {
    const entries = execSync(`ls "${chromeDir}"`, { encoding: "utf8" }).trim();
    if (entries) chromeFound = true;
  } catch {
    chromeFound = false;
  }
}

if (chromeFound) {
  console.log("[prepare-chrome] Chrome already cached, skipping install.");
  process.exit(0);
}

// ─── Install Chrome ───────────────────────────────────────────────────────────

console.log("[prepare-chrome] Chrome not found, installing...");

const _req = createRequire(path.join(PUPPETEER_PKG, "package.json"));

// Strategy 1: use puppeteer's own downloadBrowsers() which resolves the exact
// numeric buildId (146.0.7680.153) and downloads from the correct URL.
try {
  const { downloadBrowsers } = _req(
    path.join(PUPPETEER_PKG, "lib/cjs/puppeteer/node/install.js")
  );
  await downloadBrowsers();
  console.log("[prepare-chrome] Chrome installed via puppeteer downloadBrowsers().");
  chromeFound = true;
} catch (err) {
  console.warn("[prepare-chrome] downloadBrowsers() failed:", err.message);
}

// Strategy 2: use @puppeteer/browsers with the resolved numeric buildId.
if (!chromeFound) {
  try {
    const browsers = _req("@puppeteer/browsers");
    // PUPPETEER_REVISIONS.chrome is the authoritative version string.
    const revReq = createRequire(
      "/home/runner/workspace/node_modules/.pnpm/puppeteer-core@24.40.0/node_modules/puppeteer-core/package.json"
    );
    const { PUPPETEER_REVISIONS } = revReq("puppeteer-core/lib/cjs/puppeteer/revisions.js");
    const chromeVersion = PUPPETEER_REVISIONS.chrome; // "146.0.7680.153"

    const platform = browsers.detectBrowserPlatform?.() ?? "linux";
    const resolvedBuildId = await browsers.resolveBuildId(
      browsers.Browser?.CHROME ?? "chrome",
      platform,
      chromeVersion
    );
    console.log("[prepare-chrome] Resolved buildId:", resolvedBuildId);

    await browsers.install({
      browser: browsers.Browser?.CHROME ?? "chrome",
      cacheDir,
      platform,
      buildId: resolvedBuildId,
    });
    console.log("[prepare-chrome] Chrome installed via @puppeteer/browsers.");
    chromeFound = true;
  } catch (err) {
    console.warn("[prepare-chrome] @puppeteer/browsers install failed:", err.message);
  }
}

if (!chromeFound) {
  console.error(
    "[prepare-chrome] All Chrome install strategies failed. " +
    "WhatsApp client will attempt to start but may fail. " +
    "Try running: PUPPETEER_CACHE_DIR=~/.cache/puppeteer npx puppeteer@24.40.0 browsers install chrome"
  );
  // Do NOT exit — the server will still start; WhatsApp will log its own error.
}
