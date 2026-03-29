import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import os from "os";

const cacheDir = path.join(os.homedir(), ".cache", "puppeteer");
const chromeDir = path.join(cacheDir, "chrome");

// Clean up any stale Chrome SingletonLock files that block startup
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
        // ignore errors — files may not exist
      }
    }
  } catch (err) {
    console.warn("[prepare-chrome] Could not clean locks:", err.message);
  }
}

cleanChromeLocks();

let chromeFound = false;

if (existsSync(chromeDir)) {
  try {
    const entries = execSync(`ls "${chromeDir}"`, { encoding: "utf8" }).trim();
    if (entries) chromeFound = true;
  } catch {
    chromeFound = false;
  }
}

if (!chromeFound) {
  console.log("[prepare-chrome] Chrome not found, installing via puppeteer...");
  try {
    execSync("npx puppeteer browsers install chrome", {
      stdio: "inherit",
      timeout: 120000,
    });
    console.log("[prepare-chrome] Chrome installed.");
  } catch (err) {
    console.error("[prepare-chrome] Failed to install Chrome:", err.message);
    process.exit(1);
  }
} else {
  console.log("[prepare-chrome] Chrome already cached, skipping install.");
}
