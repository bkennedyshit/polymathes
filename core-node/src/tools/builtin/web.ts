import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolRegistry } from "../registry.js";

function stripHtml(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface WebConfig {
  SERPER_API_KEY?: string;
  TAVILY_API_KEY?: string;
  BRAVE_API_KEY?: string;
}

let webConfig: WebConfig = {};

export function setWebConfig(c: WebConfig): void {
  webConfig = c;
}

async function searchSerper(query: string): Promise<unknown> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": webConfig.SERPER_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query }),
  });
  return res.json();
}

async function searchTavily(query: string): Promise<unknown> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: webConfig.TAVILY_API_KEY!, query }),
  });
  return res.json();
}

async function searchBrave(query: string): Promise<unknown> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
    headers: { "X-Subscription-Token": webConfig.BRAVE_API_KEY!, Accept: "application/json" },
  });
  return res.json();
}

async function searchDuckDuckGo(query: string): Promise<unknown> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const html = await res.text();
  const results: { title: string; snippet: string }[] = [];
  const matches = html.matchAll(/<a[^>]*class="result__a"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi);
  for (const m of matches) results.push({ title: stripHtml(m[1]), snippet: stripHtml(m[2]) });
  return { results: results.slice(0, 10) };
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "web_fetch",
    description: "Fetch a URL and return text content (HTML stripped)",
    parameters: z.object({ url: z.string() }),
    async handler(args) {
      const { url } = args as { url: string };
      const res = await fetch(url);
      const text = await res.text();
      return { content: stripHtml(text), status: res.status };
    },
    toolset: "web",
  });

  registry.register({
    name: "web_fetch_full",
    description: "Fetch a URL and return raw HTML without stripping",
    parameters: z.object({ url: z.string() }),
    async handler(args) {
      const { url } = args as { url: string };
      const res = await fetch(url);
      const html = await res.text();
      return { html, status: res.status };
    },
    toolset: "web",
  });

  registry.register({
    name: "web_extract",
    description: "Fetch a page and return text content of a CSS selector",
    parameters: z.object({ url: z.string(), selector: z.string() }),
    async handler(args) {
      const { url, selector } = args as { url: string; selector: string };
      try {
        const { chromium } = await import("playwright-core");
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const text = await page.locator(selector).first().innerText();
        await browser.close();
        return { text };
      } catch (e: any) {
        return { error: e.message };
      }
    },
    toolset: "web",
  });

  registry.register({
    name: "web_screenshot",
    description: "Screenshot a URL, save to output_path or temp file",
    parameters: z.object({ url: z.string(), output_path: z.string().optional() }),
    async handler(args) {
      const { url, output_path } = args as { url: string; output_path?: string };
      try {
        const { chromium } = await import("playwright-core");
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const dest = output_path ?? join(tmpdir(), `web-screenshot-${randomBytes(4).toString("hex")}.png`);
        await page.screenshot({ path: dest });
        await browser.close();
        return { path: dest };
      } catch (e: any) {
        return { error: e.message };
      }
    },
    toolset: "web",
  });

  registry.register({
    name: "web_search",
    description: "Search the web using configured backend (Serper/Tavily/Brave/DuckDuckGo fallback)",
    parameters: z.object({ query: z.string(), backend: z.string().optional() }),
    async handler(args) {
      const { query } = args as { query: string };
      try {
        if (webConfig.SERPER_API_KEY) return await searchSerper(query);
        if (webConfig.TAVILY_API_KEY) return await searchTavily(query);
        if (webConfig.BRAVE_API_KEY) return await searchBrave(query);
        return await searchDuckDuckGo(query);
      } catch (e: any) {
        return { error: e.message };
      }
    },
    toolset: "web",
  });
}
