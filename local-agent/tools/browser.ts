/**
 * Browser automation tools - Playwright-based.
 *
 * Risk tiers:
 *   auto:    navigate, extract, screenshot, close
 *   confirm: click, type, fill_form, download (confirmation happens upstream)
 *   never:   purchase, account-security changes (hardcoded URL/field patterns below)
 *
 * Hard rules (non-negotiable):
 *   - Never bypass CAPTCHA, login walls, paywalls
 *   - Never submit a form without showing filled contents first (upstream confirm)
 *   - If a page requires auth JARVIS doesn't have, say so
 */

import { chromium, type Browser, type Page } from "playwright";

// Singleton browser instance
let browserInstance: Browser | null = null;
let currentPage: Page | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserInstance;
}

async function getPage(): Promise<Page> {
  if (!currentPage || currentPage.isClosed()) {
    const browser = await getBrowser();
    currentPage = await browser.newPage();
  }
  return currentPage;
}

// Hard-coded never patterns
const NEVER_URL_PATTERNS: RegExp[] = [
  /\b(checkout|cart|purchase|buy|payment|pay)\b/i,
  /\b(password|passwd|credentials|auth|login|signin|2fa|mfa)\b/i,
  /\b(account[^.]*delete|delete[^.]*account|unsubscribe)\b/i,
];

function isNeverUrl(url: string): boolean {
  return NEVER_URL_PATTERNS.some((p) => p.test(url));
}

// Tool implementations

export interface BrowserResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export async function browserNavigate(args: {
  url: string;
  waitFor?: number;
  signal?: AbortSignal;
}): Promise<BrowserResult & { title?: string; url?: string }> {
  const { url, waitFor = 5000, signal } = args;

  if (isNeverUrl(url)) {
    return {
      success: false,
      error: "BLOCKED: URL matches a restricted pattern (purchase/auth/security)",
    };
  }

  try {
    const page = await getPage();
    if (signal?.aborted) return { success: false, error: "Aborted" };

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: waitFor });
    const title = await page.title();
    const finalUrl = page.url();

    return { success: true, title, url: finalUrl };
  } catch (err) {
    return {
      success: false,
      error: "navigation failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserExtract(args: {
  url?: string;
  signal?: AbortSignal;
}): Promise<BrowserResult & { text?: string; title?: string }> {
  const { url, signal } = args;

  try {
    const page = await getPage();

    if (url && page.url() !== url) {
      if (isNeverUrl(url)) {
        return {
          success: false,
          error: "BLOCKED: URL matches a restricted pattern",
        };
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    }

    if (signal?.aborted) return { success: false, error: "Aborted" };

    const title = await page.title();
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      const removeSelectors = [
        "script", "style", "nav", "footer", "header",
        "noscript", "iframe", "svg",
        "[role=navigation]", "[role=banner]", "[role=contentinfo]",
      ];
      for (const sel of removeSelectors) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      }
      return clone.innerText.trim().slice(0, 50000);
    });

    return { success: true, text, title };
  } catch (err) {
    return {
      success: false,
      error: "extract failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserScreenshot(args: {
  path?: string;
  fullPage?: boolean;
  signal?: AbortSignal;
}): Promise<BrowserResult & { path?: string }> {
  const { path, fullPage = false, signal } = args;

  try {
    const page = await getPage();
    if (signal?.aborted) return { success: false, error: "Aborted" };

    const screenshotPath = path || `/tmp/jarvis-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage });

    return { success: true, path: screenshotPath };
  } catch (err) {
    return {
      success: false,
      error: "screenshot failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserClick(args: {
  selector: string;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<BrowserResult & { clicked?: string; pageTitle?: string }> {
  const { selector, timeout = 5000, signal } = args;

  try {
    const page = await getPage();
    if (signal?.aborted) return { success: false, error: "Aborted" };

    const element = await page.$(selector);
    if (!element) {
      return { success: false, error: `Element not found: ${selector}` };
    }

    const info = await element.evaluate((el) => ({
      tag: el.tagName,
      text: el.textContent?.slice(0, 100) || "",
      href: (el as HTMLAnchorElement).href || "",
    }));

    const combined = `${info.text} ${info.href}`.toLowerCase();
    if (NEVER_URL_PATTERNS.some((p) => p.test(combined))) {
      return {
        success: false,
        error: "BLOCKED: Click target matches restricted pattern",
      };
    }

    await element.click({ timeout });
    const pageTitle = await page.title();

    return {
      success: true,
      clicked: `<${info.tag}> "${info.text}"${info.href ? ` | ${info.href}` : ""}`,
      pageTitle,
    };
  } catch (err) {
    return {
      success: false,
      error: "click failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserType(args: {
  selector: string;
  text: string;
  clear?: boolean;
  pressEnter?: boolean;
  signal?: AbortSignal;
}): Promise<BrowserResult & { typed?: string; field?: string }> {
  const { selector, text, clear = true, pressEnter = false, signal } = args;

  try {
    const page = await getPage();
    if (signal?.aborted) return { success: false, error: "Aborted" };

    const element = await page.$(selector);
    if (!element) {
      return { success: false, error: `Input not found: ${selector}` };
    }

    const fieldInfo = await element.evaluate((el) => ({
      tag: el.tagName,
      placeholder: (el as HTMLInputElement).placeholder || "",
      name: (el as HTMLInputElement).name || "",
    }));

    if (clear) {
      await element.click();
      await page.keyboard.press("Meta+A");
    }

    await element.type(text, { delay: 20 });

    if (pressEnter) {
      await page.keyboard.press("Enter");
    }

    return {
      success: true,
      typed: text,
      field: `<${fieldInfo.tag} name="${fieldInfo.name}" placeholder="${fieldInfo.placeholder}">`,
    };
  } catch (err) {
    return {
      success: false,
      error: "type failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserFillForm(args: {
  fields: Array<{ selector: string; value: string }>;
  submitSelector?: string;
  signal?: AbortSignal;
}): Promise<
  BrowserResult & {
    filled?: Array<{ field: string; value: string }>;
    submitted?: boolean;
  }
> {
  const { fields, submitSelector, signal } = args;

  try {
    const page = await getPage();
    if (signal?.aborted) return { success: false, error: "Aborted" };

    const filled: Array<{ field: string; value: string }> = [];

    for (const field of fields) {
      const element = await page.$(field.selector);
      if (!element) {
        return {
          success: false,
          error: `Field not found: ${field.selector}`,
          filled,
        };
      }

      const fieldInfo = await element.evaluate((el) => ({
        tag: el.tagName,
        name: (el as HTMLInputElement).name || "",
        placeholder: (el as HTMLInputElement).placeholder || "",
        type: (el as HTMLInputElement).type || "",
      }));

      const sensitive = ["password", "credit", "card", "ssn", "social"].some(
        (s) =>
          `${fieldInfo.name} ${fieldInfo.placeholder} ${fieldInfo.type}`
            .toLowerCase()
            .includes(s)
      );
      if (sensitive) {
        return {
          success: false,
          error: `BLOCKED: Field appears sensitive (${fieldInfo.name || fieldInfo.type})`,
          filled,
        };
      }

      await element.click();
      await page.keyboard.press("Meta+A");
      await element.type(field.value, { delay: 15 });

      filled.push({
        field: `<${fieldInfo.tag} name="${fieldInfo.name}" placeholder="${fieldInfo.placeholder}">`,
        value: field.value,
      });
    }

    let submitted = false;
    if (submitSelector) {
      const submitBtn = await page.$(submitSelector);
      if (submitBtn) {
        await submitBtn.click();
        submitted = true;
      } else {
        return {
          success: false,
          error: `Submit button not found: ${submitSelector}`,
          filled,
        };
      }
    }

    return { success: true, filled, submitted };
  } catch (err) {
    return {
      success: false,
      error: "form fill failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserDownload(args: {
  url: string;
  destination?: string;
  signal?: AbortSignal;
}): Promise<BrowserResult & { path?: string }> {
  const { url, destination, signal } = args;

  if (isNeverUrl(url)) {
    return {
      success: false,
      error: "BLOCKED: URL matches a restricted pattern",
    };
  }

  try {
    const page = await getPage();
    if (signal?.aborted) return { success: false, error: "Aborted" };

    const downloadDir = destination || `/tmp/jarvis-download-${Date.now()}`;

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.evaluate((downloadUrl) => {
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = "";
        a.click();
      }, url),
    ]);

    const filePath = `${downloadDir}/${download.suggestedFilename()}`;
    await download.saveAs(filePath);

    return { success: true, path: filePath };
  } catch (err) {
    return {
      success: false,
      error: "download failed: " + (err instanceof Error ? err.message : err),
    };
  }
}

export async function browserClose(): Promise<BrowserResult> {
  try {
    if (currentPage && !currentPage.isClosed()) {
      await currentPage.close();
      currentPage = null;
    }
    if (browserInstance) {
      await browserInstance.close();
      browserInstance = null;
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: "close failed: " + (err instanceof Error ? err.message : err),
    };
  }
}
