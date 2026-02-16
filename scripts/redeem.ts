import { chromium, type Page } from "playwright";
import path from "path";

const args = process.argv.slice(2);

// Parse flags
const profileIdx = args.indexOf("--profile");
const profileName =
  profileIdx !== -1 && args[profileIdx + 1]
    ? args[profileIdx + 1]
    : "default";

const isLogin = args.includes("--login");

const profileDir = path.resolve(
  __dirname,
  "..",
  "playwright-profiles",
  profileName
);

const LOGIN_CHECK_INTERVAL = 3000;
const LOGIN_TIMEOUT = 120_000;
const SELL_THRESHOLD = 99.5; // cents — sell positions at >= 99.5¢

async function login() {
  console.log(`[redeem] 로그인 모드 (profile: ${profileName})`);
  console.log(`[redeem] 세션 저장 경로: ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: "chrome",
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://polymarket.com");

  console.log("[redeem] 브라우저에서 로그인하세요. 완료되면 브라우저를 닫으세요...");
  await context.waitForEvent("close");
  console.log("[redeem] 세션 저장 완료.");
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const loginBtn = page.locator(
    'button:has-text("Log In"), a:has-text("Log In"), button:has-text("Sign Up")'
  );
  if ((await loginBtn.count()) > 0) return false;

  const loggedIn = page.locator(
    '[data-testid="portfolio"], a[href="/portfolio"], [class*="avatar"], [class*="wallet"]'
  );
  if ((await loggedIn.count()) > 0) return true;

  if (page.url().includes("/portfolio")) return true;
  return false;
}

async function waitForLogin(page: Page): Promise<boolean> {
  console.log("[redeem] 로그인이 필요합니다. 브라우저에서 로그인하세요...");
  await page.goto("https://polymarket.com");
  await page.waitForLoadState("networkidle");

  const start = Date.now();
  while (Date.now() - start < LOGIN_TIMEOUT) {
    if (await isLoggedIn(page)) {
      console.log("[redeem] 로그인 확인됨!");
      return true;
    }
    await page.waitForTimeout(LOGIN_CHECK_INTERVAL);
  }

  console.error("[redeem] 로그인 타임아웃 (2분 초과)");
  return false;
}

/**
 * Parse "NOW" price from a position row text.
 * Row text example: "Ethereum...Down 97¢111.5 shares97¢100.0¢$107.56..."
 * Pattern: badge(N¢) → shares → AVG(N¢) → NOW(N¢) → dollar values
 * The NOW price is the last ¢-value before the first $ sign.
 */
function parseNowPrice(text: string): number | null {
  // Cut off everything from the first $ onward (dollar values)
  const beforeDollar = text.split("$")[0];
  // Find all cent values in the remaining text
  const prices = [...beforeDollar.matchAll(/([\d.]+)¢/g)].map((m) => parseFloat(m[1]));
  // NOW is the last cent value before dollar amounts
  return prices.length > 0 ? prices[prices.length - 1] : null;
}

/** Extract market name from row text */
function parseMarketName(text: string): string {
  // Text starts with market name, ends before the first badge like "Down", "No", "Yes", "Up"
  const match = text.match(/^(.*?)(?:Down|Up|Yes|No)\s/);
  return match ? match[1].trim().slice(0, 60) : text.slice(0, 60);
}

async function redeem() {
  console.log(`[redeem] Redeem 모드 (profile: ${profileName})`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: "chrome",
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto("https://polymarket.com/portfolio");
    await page.waitForLoadState("networkidle");

    // Check login state
    if (!(await isLoggedIn(page))) {
      const loggedIn = await waitForLogin(page);
      if (!loggedIn) {
        console.error("[redeem] 로그인 실패, 종료합니다.");
        await context.close();
        return;
      }
      await page.goto("https://polymarket.com/portfolio");
      await page.waitForLoadState("networkidle");
    }

    await page.waitForTimeout(5000);

    let claimSuccess = 0;
    let claimFailed = 0;
    let sellSuccess = 0;
    let sellFailed = 0;

    // ── Phase 1: Claim resolved positions ──
    const claimButtons = page.locator(
      'button:has-text("Claim"), button:has-text("Redeem")'
    );
    const claimCount = await claimButtons.count();

    if (claimCount > 0) {
      console.log(`[redeem] ${claimCount}개의 Claim 버튼 발견`);
      for (let i = 0; i < claimCount; i++) {
        try {
          const buttons = page.locator('button:has-text("Claim")');
          if ((await buttons.count()) === 0) break;

          await buttons.first().click();

          const confirm = page.locator('button:has-text("Claim Proceeds")');
          await confirm.waitFor({ state: "visible", timeout: 5000 });
          await confirm.click();
          await page.waitForTimeout(3000);

          claimSuccess++;
          console.log(`[redeem] Claim ${claimSuccess} 완료`);
        } catch (err) {
          claimFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[redeem] Claim 실패: ${msg}`);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(1000);
        }
      }
    }

    // ── Phase 2: Sell near-confirmed positions (NOW >= 99.5¢) ──
    // DOM structure: Sell button → ../../.. = full row div with all text
    const sellButtons = page.locator('button:has-text("Sell")');
    const sellCount = await sellButtons.count();

    console.log(`[redeem] ${sellCount}개의 Sell 버튼 발견, ${SELL_THRESHOLD}¢ 이상 포지션 검색 중...`);

    // Collect visible sell targets (desktop/mobile both render Sell buttons — skip hidden ones)
    const sellTargets: { index: number; marketName: string; nowPrice: number }[] = [];

    for (let i = 0; i < sellCount; i++) {
      try {
        const sellBtn = sellButtons.nth(i);
        if (!(await sellBtn.isVisible())) continue;

        // Go 3 levels up to the full row container
        const row = sellBtn.locator("xpath=../../..");
        const rowText = await row.textContent({ timeout: 3000 });
        if (!rowText) continue;

        const nowPrice = parseNowPrice(rowText);
        if (nowPrice === null) continue;

        const marketName = parseMarketName(rowText);

        if (nowPrice < SELL_THRESHOLD) {
          console.log(`[redeem]   skip: ${marketName} (NOW: ${nowPrice}¢)`);
          continue;
        }

        console.log(`[redeem]   HIT: ${marketName} (NOW: ${nowPrice}¢)`);
        sellTargets.push({ index: i, marketName, nowPrice });
      } catch {
        // Row parse failed, skip
      }
    }

    // Execute sells (process in reverse order so indices stay valid)
    for (const target of sellTargets.reverse()) {
      try {
        console.log(`[redeem]   selling: ${target.marketName} @ ${target.nowPrice}¢...`);

        const btn = page.locator('button:has-text("Sell")').nth(target.index);
        await btn.click();

        // Wait for modal dialog to open
        const dialog = page.locator('[role="dialog"], [data-state="open"][data-slot="dialog-content"]');
        await dialog.waitFor({ state: "visible", timeout: 5000 });
        await page.waitForTimeout(1000);

        // Wait for modal to load real price (initially shows "@ 0.0¢", then updates)
        let modalPrice = 0;
        const pollStart = Date.now();
        while (Date.now() - pollStart < 10000) {
          const dialogText = await dialog.textContent({ timeout: 2000 }) ?? "";
          // Parse "Selling 111 shares @ 99.9¢"
          const priceMatch = dialogText.match(/@\s*([\d.]+)¢/);
          if (priceMatch) {
            modalPrice = parseFloat(priceMatch[1]);
            if (modalPrice > 0) break;
          }
          await page.waitForTimeout(1000);
        }

        console.log(`[redeem]   modal price: ${modalPrice}¢`);

        if (modalPrice < SELL_THRESHOLD) {
          console.log(`[redeem]   skip sell: modal price ${modalPrice}¢ < ${SELL_THRESHOLD}¢, closing modal`);
          await page.keyboard.press("Escape");
          await page.waitForTimeout(1000);
          continue;
        }

        // Click "Cash out" confirm button in the modal
        const cashOutBtn = dialog.locator('button:has-text("Cash out")');
        if ((await cashOutBtn.count()) > 0) {
          await cashOutBtn.click({ timeout: 5000 });
        } else {
          const confirmSell = dialog.locator('button:has-text("Sell")');
          await confirmSell.click({ timeout: 5000 });
        }
        await page.waitForTimeout(4000);

        sellSuccess++;
        console.log(`[redeem]   Sell ${sellSuccess} 완료: ${target.marketName}`);
      } catch (err) {
        sellFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[redeem]   Sell 실패: ${msg}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(1000);
      }
    }

    console.log(
      `[redeem] 완료 — Claim: 성공 ${claimSuccess}, 실패 ${claimFailed} | Sell(≥${SELL_THRESHOLD}¢): 성공 ${sellSuccess}, 실패 ${sellFailed}`
    );
  } finally {
    await context.close();
  }
}

async function main() {
  try {
    if (isLogin) {
      await login();
    } else {
      await redeem();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[redeem] 오류: ${msg}`);
    process.exit(1);
  }
}

main();
