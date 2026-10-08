#!/usr/bin/env bash
# Fresh-clone check (PLAN.md M8): clone this repo at HEAD into a temp dir, run the README
# commands, and confirm the server answers and the garden renders. Cleans up after itself.
#
#   pnpm check:fresh                 # clones file://<this repo> at HEAD (no network needed for git)
#   REPO_URL=https://github.com/lamgs/agent-garden pnpm check:fresh
#
# Needs: git, pnpm, curl, port 4310 free (the README's URL), and a Chromium for Playwright
# (/opt/pw-browsers/chromium-1194 if present, else Playwright's default).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="${REPO_URL:-file://$ROOT}"
PORT=4310
BASE="http://127.0.0.1:$PORT"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/garden-fresh-XXXXXX")"
SERVER_PID=""
T0=$(date +%s)

step() { printf '\n[%3ss] %s\n' "$(($(date +%s) - T0))" "$*"; }
fail() { echo "FAIL: $*" >&2; [ -f "$TMP/demo.log" ] && tail -40 "$TMP/demo.log" >&2; exit 1; }
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill -- "-$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
  fail "something already answers on $BASE; stop it first (the README's demo uses port $PORT)"
fi

step "git clone $REPO_URL (HEAD $(git -C "$ROOT" rev-parse --short HEAD)) → $TMP/agent-garden"
git clone -q "$REPO_URL" "$TMP/agent-garden"
cd "$TMP/agent-garden"

step "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile --reporter=silent

step "pnpm demo (background)"
setsid pnpm demo >"$TMP/demo.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 240); do
  curl -fsS "$BASE/api/health" >"$TMP/health.json" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "pnpm demo exited before the server came up"
  sleep 1
done
[ -s "$TMP/health.json" ] || fail "no answer from $BASE/api/health after 240 s"
step "health: $(cat "$TMP/health.json")"

curl -fsS "$BASE/api/garden" >"$TMP/garden.json"
node -e '
  const g = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const beds = g.beds.map((b) => b.name);
  console.log(`garden: ${beds.length} beds (${beds.join(", ")}), ${g.plants.length} plants`);
  if (beds.length < 6) { console.error("expected at least 6 beds"); process.exit(1); }
' "$TMP/garden.json" || fail "/api/garden check"

step "render the page in headless Chromium"
cat >"$TMP/agent-garden/apps/web/fresh-render.mjs" <<'EOF'
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const url = process.argv[2];
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.hostname !== '127.0.0.1' && !['data:', 'blob:'].includes(u.protocol))
    errors.push(`external request: ${r.url()}`);
});
await page.goto(url);
await page.waitForFunction(() => window.__garden?.ready === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(3000); // let the live stream connect and play a little
const plants = await page.evaluate(() => window.__garden.plants);
const pill = await page.locator('[data-live-pill]').textContent();
await browser.close();
console.log(`page: window.__garden.ready, ${plants} plants drawn; live pill "${pill?.trim()}"; console errors: ${errors.length}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (plants < 1) process.exit(1);
EOF
(cd "$TMP/agent-garden/apps/web" && node fresh-render.mjs "$BASE/") || fail "page did not render cleanly"

step "PASS: fresh clone → pnpm install → pnpm demo → garden renders (cleaning up)"
