// Browser walk-through of the review UI against the sandbox server.
// Run with `npm run test:e2e`. Needs a Chromium that playwright-core can find
// (PLAYWRIGHT_BROWSERS_PATH) or CHROMIUM_PATH pointing at an executable.
// Set E2E_SCREENSHOTS=<dir> to save screenshots of the key states.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { startServer } from "../src/server/serve.ts";
import { SCHEMA_VERSION } from "../src/types.ts";

let browser: Browser;
let page: Page;
let url: string;
let stop: () => void;
const shots = process.env.E2E_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

async function shot(name: string, p: Page = page) {
  if (shots) await p.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

async function control(label: RegExp) {
  await page.getByRole("button", { name: label }).click();
  await page.locator("#notice .banner").waitFor();
}

async function commitViaDialog() {
  await page.locator("#commit").click();
  const dialog = page.locator("#confirm");
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "Commit approved changes" }).click();
  await dialog.waitFor({ state: "hidden" });
}

before(async () => {
  const server = await startServer({ port: 0, reviewer: "@e2e" });
  url = server.url;
  stop = () => server.server.close();
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (err) => assert.fail(`page error: ${err.message}`));
});

after(async () => {
  await browser?.close();
  stop?.();
});

describe("review UI", () => {
  it("opens the seeded transaction grouped by object, with the dangerous action flagged", async () => {
    await page.goto(url);
    await page.locator("h1.outcome").waitFor();
    assert.equal(await page.locator("h1.outcome").textContent(), "Triage the issues opened during the 4.2 release");
    assert.equal(await page.locator("#panel .action").count(), 12);
    assert.equal(await page.locator("#panel .object").count(), 4);
    const a8 = page.locator('[data-action="a8"]');
    assert.match((await a8.textContent()) ?? "", /high risk/);
    assert.match((await page.locator(".evidence").textContent()) ?? "", /not verified/i);
    await shot("01-review");
  });

  it("edits a title and rejects three actions, each as a new revision", async () => {
    for (const id of ["a5", "a7", "a8"]) {
      await page.locator(`[data-action="${id}"] .toggle`).click();
      await page.locator(`[data-action="${id}"].rejected`).waitFor();
    }
    await page.locator('[data-action="a1"] [data-role="edit"]').click();
    await page.locator("#edit-a1-title").fill("Crash when saving a file with a non-ASCII name");
    await page.getByRole("button", { name: "Save edit" }).click();
    await page.locator('[data-action="a1"] .tag.edited').waitFor();
    assert.match((await page.locator(".commit-bar").textContent()) ?? "", /9 of 12 actions/);
    assert.match((await page.locator(".crumbs").textContent()) ?? "", /revision 5/);
    await shot("02-edited");
  });

  it("commits through a confirmation that states lasting effects, and lands in verification_failed", async () => {
    await page.locator("#commit").click();
    const dialog = page.locator("#confirm");
    await dialog.waitFor({ state: "visible" });
    assert.match((await dialog.textContent()) ?? "", /assigned users have already been notified/);
    assert.doesNotMatch((await dialog.textContent()) ?? "", /\bnull\b|undefined/);
    await shot("03-confirm");
    await dialog.getByRole("button", { name: "Commit approved changes" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".rail-table").waitFor();
    assert.match((await page.locator(".banner.bad h2").first().textContent()) ?? "", /didn't take effect/);
    const a4 = page.locator(".rail-table tr", { hasText: "Assign @alex" });
    assert.match((await a4.textContent()) ?? "", /not in approved state/);
    assert.match((await page.locator(".stub").textContent()) ?? "", /Exactly-once.*guaranteed/);
    assert.doesNotMatch((await page.locator("#view").textContent()) ?? "", /\bnull\b|undefined/);
    await shot("04-receipt-verification-failed");
  });

  it("a client retry writes nothing", async () => {
    await control(/Agent client retries/);
    assert.match((await page.locator("#notice").textContent()) ?? "", /GitHub writes caused by the retry: 0/);
  });

  it("compensation is a separate transaction that must be reviewed and committed", async () => {
    await page.getByRole("checkbox", { name: "Select a1 for compensation" }).check();
    await page.getByRole("button", { name: /Propose compensation for a1/ }).click();
    await page.waitForURL(/c1$/);
    await page.locator(".banner.note", { hasText: "Recovery is a new transaction" }).waitFor();
    await shot("05-compensation-review");
    await commitViaDialog();
    await page.locator(".banner.good", { hasText: "Verified" }).waitFor();
    await page.locator("a.mono", { hasText: "triage-release-4-2" }).first().click();
    await page.locator(".banner.good", { hasText: "Recovered" }).waitFor();
  });

  it("a change after preview stops the commit before any write, then rebases", async () => {
    await control(/Agent submits a follow-up/);
    await page.locator(".inbox-item", { hasText: "regression" }).click();
    await page.locator("h1.outcome", { hasText: "regression" }).waitFor();
    await control(/Teammate edits a target/);
    await commitViaDialog();
    await page.locator(".conflict-table").waitFor();
    const conflict = (await page.locator(".conflict-table").textContent()) ?? "";
    assert.match(conflict, /p1/);
    assert.match(conflict, /regression/);
    await shot("06-conflict");
    await page.getByRole("button", { name: "Rebase onto current state" }).click();
    await page.locator(".banner", { hasText: "Rebased onto GitHub's current state" }).first().waitFor();
    await commitViaDialog();
    await page.locator(".banner.good", { hasText: "Verified" }).waitFor();
  });

  it("shows an intact hash-chained ledger", async () => {
    await page.getByRole("tab", { name: /Ledger/ }).click();
    await page.locator(".chain.good").waitFor();
    assert.ok((await page.locator(".events tbody tr").count()) > 5);
  });

  it("an outage fails closed, and an expired approval must be renewed", async () => {
    await control(/Reset sandbox/);
    await page.locator("h1.outcome", { hasText: "4.2 release" }).waitFor();
    await control(/GitHub outage/);
    await commitViaDialog();
    await page.locator("#notice .banner.bad", { hasText: "GitHub can't be reached" }).waitFor();
    await page.locator(".banner.note", { hasText: "Approved, not yet committed" }).waitFor();
    await shot("07-outage");
    await control(/GitHub outage/);
    await control(/Fast-forward/);
    await commitViaDialog();
    await page.locator("#notice .banner.bad", { hasText: "approval expired" }).waitFor();
    await page.locator(".banner.note", { hasText: "earlier approval expired" }).waitFor();
  });

  it("keyboard: j moves between actions and x rejects the focused one", async () => {
    await page.locator("#main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("x");
    await page.locator('[data-action="a2"].rejected').waitFor();
  });

  it("renders agent-supplied text as text, never as markup", async () => {
    const res = await page.request.post(`${url}api/change-sets`, {
      headers: { "content-type": "application/json" },
      data: {
        schema_version: SCHEMA_VERSION,
        transaction_id: "xss-probe",
        workspace_id: "ws-demo",
        source_agent: "agent",
        initiator: "@x",
        requested_outcome: '<img src=x onerror="window.__pwned=1">',
        connector: "github",
        actions: [{ id: "a", operation: "issue.add_comment", target: { kind: "github.issue", owner: "acme", repo: "widgets", number: 195 }, params: { body: "<script>window.__pwned=1</script>" } }],
        evidence: [{ label: "<b>x</b>", content: '<img src=x onerror="window.__pwned=1">' }],
      },
    });
    assert.equal(res.status(), 200);
    await page.goto(`${url}#/tx/xss-probe`);
    await page.locator(".crumbs", { hasText: "xss-probe" }).waitFor();
    assert.equal(await page.locator("h1.outcome").textContent(), '<img src=x onerror="window.__pwned=1">');
    assert.equal(await page.locator("#view img, #view script").count(), 0);
    assert.equal(await page.evaluate("window.__pwned"), undefined);
  });

  it("works at phone width and in dark mode", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    await phone.goto(`${url}#/tx/triage-release-4-2`);
    await phone.locator("h1.outcome").waitFor();
    const overflow = (await phone.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
    assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px`);
    await shot("08-phone-dark", phone);
    await phone.close();
  });
});
