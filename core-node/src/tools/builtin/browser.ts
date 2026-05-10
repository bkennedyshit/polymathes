import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolRegistry } from "../registry.js";

let browser: import("playwright-core").Browser | null = null;
let page: import("playwright-core").Page | null = null;

async function getBrowser() {
  if (!browser) {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function getPage() {
  if (!page || page.isClosed()) {
    const b = await getBrowser();
    page = await b.newPage();
  }
  return page;
}

function checkChromium(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pw = require("playwright-core");
    pw.chromium.executablePath();
    return true;
  } catch {
    return false;
  }
}

export function register(registry: ToolRegistry): void {
  const toolset = "browser";
  const check_fn = checkChromium;

  registry.register({
    name: "browser_open",
    description: "Open a URL in the browser, returns page title and first 500 chars of text",
    parameters: z.object({ url: z.string() }),
    check_fn,
    toolset,
    async handler(args) {
      const { url } = args as { url: string };
      try {
        const p = await getPage();
        await p.goto(url, { waitUntil: "domcontentloaded" });
        const title = await p.title();
        const text = await p.innerText("body").catch(() => "");
        return { title, text: text.slice(0, 500) };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });

  registry.register({
    name: "browser_click",
    description: "Click an element matching a CSS selector",
    parameters: z.object({ selector: z.string() }),
    check_fn,
    toolset,
    async handler(args) {
      const { selector } = args as { selector: string };
      try {
        const p = await getPage();
        await p.click(selector);
        return { ok: true };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });

  registry.register({
    name: "browser_type",
    description: "Type text into an element matching a CSS selector",
    parameters: z.object({ selector: z.string(), text: z.string() }),
    check_fn,
    toolset,
    async handler(args) {
      const { selector, text } = args as { selector: string; text: string };
      try {
        const p = await getPage();
        await p.fill(selector, text);
        return { ok: true };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });

  registry.register({
    name: "browser_screenshot",
    description: "Take a screenshot, save to path or temp file, returns file path",
    parameters: z.object({ path: z.string().optional() }),
    check_fn,
    toolset,
    async handler(args) {
      const { path: savePath } = args as { path?: string };
      try {
        const p = await getPage();
        const dest = savePath ?? join(tmpdir(), `screenshot-${randomBytes(4).toString("hex")}.png`);
        await p.screenshot({ path: dest });
        return { path: dest };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });

  registry.register({
    name: "browser_eval",
    description: "Evaluate JavaScript in the page context and return the result",
    parameters: z.object({ script: z.string() }),
    check_fn,
    toolset,
    async handler(args) {
      const { script } = args as { script: string };
      try {
        const p = await getPage();
        const result = await p.evaluate(script);
        return { result };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });

  registry.register({
    name: "browser_scrape_dom",
    description: "Return innerHTML of a selector or the full body",
    parameters: z.object({ selector: z.string().optional() }),
    check_fn,
    toolset,
    async handler(args) {
      const { selector } = args as { selector?: string };
      try {
        const p = await getPage();
        const html = await p.innerHTML(selector ?? "body");
        return { html };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });

  registry.register({
    name: "browser_close",
    description: "Close the browser instance",
    parameters: z.object({}),
    check_fn,
    toolset,
    async handler() {
      try {
        if (page && !page.isClosed()) await page.close();
        if (browser) await browser.close();
        page = null;
        browser = null;
        return { ok: true };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  });
}
