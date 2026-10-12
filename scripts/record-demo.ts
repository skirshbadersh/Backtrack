// Records the ~60-second demo video from the real review UI running against the
// sandbox, in the PRD's demo order: duplicate retry and verification failure first,
// then reviewable compensation, then the stale-state block.
//
//   npm run record                 # writes docs/media/demo.mp4 and demo-poster.png
//
// Needs Chromium (playwright-core finds the preinstalled one, or set CHROMIUM_PATH)
// and ffmpeg with libx264 on PATH.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";
import { startServer } from "../src/server/serve.ts";

const OUT = fileURLToPath(new URL("../docs/media/", import.meta.url));
const SIZE = { width: 1280, height: 720 };

// Overlay styles. The page's CSP is bypassed for this browser context only, so the
// recording can draw captions; the product itself ships with a strict CSP.
const OVERLAY_CSS = `
#rec-caption { position: fixed; left: 50%; bottom: 92px; transform: translateX(-50%); z-index: 9999;
  max-width: 1040px; padding: 14px 22px; border-radius: 8px; background: rgba(24,25,22,.92); color: #f7f5ef;
  font: 600 22px/1.35 system-ui, sans-serif; letter-spacing: -.01em; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.25);
  transition: opacity .25s ease; }
#rec-caption small { display: block; font: 500 15px/1.4 system-ui, sans-serif; color: #c3c1b8; margin-top: 4px; letter-spacing: 0; }
#rec-caption.hidden { opacity: 0; }
#rec-tag { position: fixed; top: 10px; right: 12px; z-index: 9999; padding: 4px 8px; border-radius: 4px;
  background: rgba(24,25,22,.85); color: #f7f5ef; font: 500 12px/1.2 ui-monospace, monospace; letter-spacing: .04em; }
#rec-ring { position: fixed; z-index: 9998; pointer-events: none; border: 3px solid #2f4a8a; border-radius: 8px;
  box-shadow: 0 0 0 4px rgba(47,74,138,.25); transition: all .35s ease; opacity: 0; }
#rec-card { position: fixed; inset: 0; z-index: 10000; background: #181916; color: #e8e6de; display: grid; place-items: center;
  font: 650 40px/1.25 system-ui, sans-serif; letter-spacing: -.02em; text-align: center; padding: 0 120px; transition: opacity .4s ease; }
#rec-card small { display: block; margin-top: 18px; font: 500 20px/1.5 system-ui, sans-serif; color: #9c9b92; letter-spacing: 0; }
#rec-card.hidden { opacity: 0; pointer-events: none; }
`;

async function installOverlay(page: Page) {
  await page.addStyleTag({ content: OVERLAY_CSS });
  await page.evaluate(() => {
    for (const id of ["rec-caption", "rec-tag", "rec-ring", "rec-card"]) {
      const el = document.createElement("div");
      el.id = id;
      if (id !== "rec-tag") el.className = "hidden";
      document.body.append(el);
    }
    document.getElementById("rec-tag")!.textContent = "SANDBOX · SIMULATED GITHUB";
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function caption(page: Page, text: string, sub = "") {
  await page.evaluate(
    ([t, s]) => {
      const el = document.getElementById("rec-caption")!;
      el.replaceChildren(document.createTextNode(t!));
      if (s) {
        const small = document.createElement("small");
        small.textContent = s;
        el.append(small);
      }
      el.className = "";
    },
    [text, sub],
  );
}

async function card(page: Page, text: string, sub: string, ms: number) {
  await page.evaluate(
    ([t, s]) => {
      const el = document.getElementById("rec-card")!;
      const block = document.createElement("div");
      const small = document.createElement("small");
      small.textContent = s!;
      block.append(document.createTextNode(t!), small);
      el.replaceChildren(block);
      el.className = "";
    },
    [text, sub],
  );
  await pause(ms);
  await page.evaluate(() => (document.getElementById("rec-card")!.className = "hidden"));
  await pause(400);
}

/** Draws a ring around the element, so viewers can see what is about to be clicked. */
async function point(page: Page, target: Locator, ms = 700) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) {
    await page.evaluate(
      (b) => {
        const r = document.getElementById("rec-ring")!;
        Object.assign(r.style, { left: `${b.x - 6}px`, top: `${b.y - 6}px`, width: `${b.width + 12}px`, height: `${b.height + 12}px`, opacity: "1" });
      },
      box,
    );
  }
  await pause(ms);
}

async function unpoint(page: Page) {
  await page.evaluate(() => (document.getElementById("rec-ring")!.style.opacity = "0"));
}

async function click(page: Page, target: Locator, ms = 700) {
  await point(page, target, ms);
  await target.click();
  await unpoint(page);
}

async function scrollTo(page: Page, target: Locator, ms = 900) {
  await target.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await pause(ms);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const raw = mkdtempSync(join(tmpdir(), "bt-rec-"));
  const { server, url } = await startServer({ port: 0, reviewer: "@maintainer" });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: raw, size: SIZE }, bypassCSP: true, colorScheme: "light", deviceScaleFactor: 1 });
  const page = await context.newPage();
  const started = Date.now();

  try {
    await page.goto(url);
    await page.locator("h1.outcome").waitFor();
    await installOverlay(page);

    // 0 — the promise
    await card(page, "The write you approved is the write that happens.", "Exactly once, with proof. An agent proposes 12 GitHub issue changes; here is the review.", 4200);

    // 1 — grouped review, planted dangerous action
    await caption(page, "One transaction: 12 actions across 4 issues, with before → after per object");
    await pause(2200);
    const a8 = page.locator('[data-action="a8"]');
    await scrollTo(page, a8);
    await caption(page, "The agent wants to close #207 as a duplicate. The evidence is a similarity score.", "It's a different bug. Reject it, and the comment that goes with it.");
    await point(page, a8, 1600);
    for (const id of ["a8", "a7"]) await click(page, page.locator(`[data-action="${id}"] .toggle`), 450);
    await page.locator('[data-action="a7"].rejected').waitFor();
    await pause(500);
    await scrollTo(page, page.locator('[data-action="a5"]'), 600);
    await caption(page, "Item-level control: reject the premature public comment, fix the title");
    await click(page, page.locator('[data-action="a5"] .toggle'), 450);
    await page.locator('[data-action="a5"].rejected').waitFor();
    await scrollTo(page, page.locator('[data-action="a1"]'), 500);
    await click(page, page.locator('[data-action="a1"] [data-role="edit"]'), 400);
    await page.locator("#edit-a1-title").fill("");
    await page.locator("#edit-a1-title").pressSequentially("Crash when saving a file with a non-ASCII name", { delay: 18 });
    await click(page, page.getByRole("button", { name: "Save edit" }), 350);
    await page.locator('[data-action="a1"] .tag.edited').waitFor();
    await pause(700);

    // 2 — commit, bound to the payload
    await caption(page, "Commit approved changes: the approval is bound to this exact payload hash");
    await click(page, page.locator("#commit"), 600);
    const dialog = page.locator("#confirm");
    await dialog.waitFor({ state: "visible" });
    await pause(2600);
    await click(page, dialog.getByRole("button", { name: "Commit approved changes" }), 500);
    await page.locator(".rail-table").waitFor();

    // 3 — verification failure (lead failure #2 in the PRD)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await caption(page, "GitHub returned success for every write. The reread says one didn't happen.", "Assigning @alex returned 2xx, but GitHub silently dropped it. Verdict: verification failed, not verified.");
    await pause(2600);
    const a4row = page.locator(".rail-table tr", { hasText: "Assign @alex" });
    await scrollTo(page, a4row, 500);
    await point(page, a4row.locator("td.diverged"), 2600);
    await unpoint(page);

    // 4 — exactly-once under retry (lead failure #1 in the PRD)
    await caption(page, "The agent's client timed out, so it retries the whole thing.", "Same change set, same commit, sent again.");
    await pause(1500);
    await click(page, page.getByRole("button", { name: /Agent client retries/ }), 600);
    await page.locator("#notice .banner").waitFor();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await point(page, page.locator("#notice .banner"), 400);
    await caption(page, "Writes caused by the retry: 0", "The original receipt comes back from the ledger. Nothing is posted twice.");
    await pause(3200);
    await unpoint(page);

    // 5 — reviewable compensation
    await caption(page, "Recovery is never automatic: it's a new transaction you review");
    const pick = page.getByRole("checkbox", { name: "Select a1 for compensation" });
    await scrollTo(page, pick, 500);
    await click(page, pick, 500);
    await click(page, page.getByRole("button", { name: /Propose compensation for a1/ }), 500);
    await page.waitForURL(/c1$/);
    await page.locator(".banner.note", { hasText: "Recovery is a new transaction" }).waitFor();
    await pause(1800);
    await click(page, page.locator("#commit"), 400);
    await dialog.waitFor({ state: "visible" });
    await pause(900);
    await click(page, dialog.getByRole("button", { name: "Commit approved changes" }), 400);
    await page.locator(".banner.good", { hasText: "Verified" }).waitFor();
    await caption(page, "Title restored and verified, with the lasting effects stated", "Both renames stay visible in the issue timeline; nothing pretends to be undone.");
    await pause(2600);

    // 6 — stale-state block ("and we check this too")
    await page.getByRole("button", { name: /Agent submits a follow-up/ }).click();
    await page.locator(".inbox-item", { hasText: "regression" }).click();
    await page.locator("h1.outcome", { hasText: "regression" }).waitFor();
    await caption(page, "And we check this too: a teammate edits the issue after you reviewed it…");
    await pause(1200);
    await click(page, page.getByRole("button", { name: /Teammate edits a target/ }), 600);
    await page.locator("#commit").click();
    await dialog.waitFor({ state: "visible" });
    await pause(500);
    await dialog.getByRole("button", { name: "Commit approved changes" }).click();
    await page.locator(".conflict-table").waitFor();
    await caption(page, "Stopped before any write: approved against vs. GitHub now vs. what it would have become");
    await point(page, page.locator(".conflict-table"), 3400);
    await unpoint(page);

    // end card
    await card(page, "Exactly-once commit · verification by reread · reviewable recovery · stale-state check", "Phase 0 prototype. Sandbox shown; the same engine runs against a real GitHub repository.", 4200);
  } finally {
    await context.close(); // flushes the video
    await browser.close();
    server.close();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const webm = readdirSync(raw).find((f) => f.endsWith(".webm"));
  if (!webm) throw new Error("no video was recorded");
  const src = join(raw, webm);
  const mp4 = join(OUT, "demo.mp4");
  const poster = join(OUT, "demo-poster.png");
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  // H.264 plays everywhere (Show HN, social, the landing page); plus a poster frame.
  ff(["-i", src, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  ff(["-ss", "22", "-i", src, "-frames:v", "1", poster]);
  rmSync(raw, { recursive: true, force: true });
  for (const f of [mp4, poster]) console.log(`${f}  ${(statSync(f).size / 1024).toFixed(0)} kB`);
  console.log(`recorded ${seconds}s`);
}

await main();
