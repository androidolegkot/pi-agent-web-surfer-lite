import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SEARCH_URL = "https://www.google.com/search?q=";
const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9223;
const CDP_HOST_PORT = `${CDP_HOST}:${CDP_PORT}`;

const BROWSER_PID_FILE = "/tmp/web-surfer-lite-typescript-browser.pid";

// Directory where page dumps are saved when as_file is true
const SAVE_PAGE_DIR = "/tmp";

const BROWSER_BIN =
  "/opt/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

const BROWSER_ARGS = [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  `--remote-debugging-address=${CDP_HOST}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "--disable-blink-features=AutomationControlled",
  "--lang=ru-RU,ru",
  "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  `--user-data-dir=${path.join(os.homedir(), "chromium_headless_shell-profile")}`,
  "https://example.com",
];

const DEFAULT_TEXT_LIMIT = 100_000; // characters
const DEFAULT_HTML_LIMIT = 1_000_000; // characters
const DEFAULT_JSON_LIMIT = 1000; // DOM elements
const DEFAULT_READ_TIMEOUT = 10; // seconds, for *_and_read when timeout is not given
const NO_LIMIT = Number.MAX_SAFE_INTEGER; // used when saving the full page to a file

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class SurferError extends Error {}

const NAVIGATION_NOTE =
  "Navigation only: the page content is NOT returned. To read the page, call get_page_content as a separate call after this result.";

type Args = Record<string, any>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Commands are executed strictly one after another (serialized with a promise chain)
let commandChain: Promise<unknown> = Promise.resolve();
function withCommandLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = commandChain.then(fn, fn);
  commandChain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Chromium CDP
// ---------------------------------------------------------------------------

async function httpJson(urlPath: string, timeoutSec = 2): Promise<any> {
  try {
    const response = await fetch(`http://${CDP_HOST_PORT}${urlPath}`, {
      signal: AbortSignal.timeout(Math.max(0.2, timeoutSec) * 1000),
    });
    return await response.json();
  } catch (exc) {
    throw new SurferError(`Cannot reach Chromium CDP at ${CDP_HOST_PORT}: ${exc}`);
  }
}

async function pageWebSocketUrl(): Promise<string> {
  const pages = await httpJson("/json/list");
  for (const page of pages) {
    if (page.type === "page" && page.webSocketDebuggerUrl) {
      return page.webSocketDebuggerUrl;
    }
  }
  throw new SurferError("No Chromium page target found");
}

// One short-lived WebSocket connection per CDP command
async function cdp(method: string, params: Record<string, any> = {}, timeoutSec = 10): Promise<any> {
  const WS = (globalThis as any).WebSocket;
  if (!WS) {
    throw new SurferError("Global WebSocket is not available. Node.js 22+ is required");
  }
  const url = await pageWebSocketUrl();
  const timeoutMs = Math.max(1, timeoutSec) * 1000;

  return new Promise<any>((resolve, reject) => {
    const ws = new WS(url);
    let done = false;

    const finish = (err: Error | null, value?: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(
      () => finish(new SurferError(`CDP command timed out: ${method}`)),
      timeoutMs,
    );

    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    };
    ws.onmessage = (event: any) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== 1) return;
      if (message.error) {
        finish(new SurferError("CDP error: " + JSON.stringify(message.error)));
      } else {
        finish(null, message.result ?? {});
      }
    };
    ws.onerror = (event: any) => {
      finish(new SurferError(`CDP command failed (${method}): ${event?.message ?? "websocket error"}`));
    };
    ws.onclose = () => {
      finish(new SurferError(`CDP command failed (${method}): connection closed`));
    };
  });
}

async function evaluate(expression: string, timeoutSec = 10): Promise<any> {
  const result = await cdp(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    },
    timeoutSec,
  );
  if (result.exceptionDetails) {
    throw new SurferError(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "JavaScript evaluation failed",
    );
  }
  const remote = result.result ?? {};
  if (remote.subtype === "error") {
    throw new SurferError(remote.description || "JavaScript error");
  }
  return remote.value;
}

async function waitForLoad(timeoutSec: number): Promise<void> {
  if (timeoutSec <= 0) return;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      if ((await evaluate("document.readyState", 2)) === "complete") return;
    } catch {
      /* ignore */
    }
    await sleep(150);
  }
}

async function navigate(url: string, timeoutSec = 0): Promise<void> {
  await cdp("Page.navigate", { url }, 10);
  await waitForLoad(timeoutSec);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function cssEscape(value: string): string {
  let out = "";
  [...String(value)].forEach((char, i) => {
    const code = char.codePointAt(0)!;
    if (/[A-Za-z0-9_-]/.test(char) || code >= 128) {
      out += i === 0 && /[0-9]/.test(char) ? "\\3" + char + " " : char;
    } else {
      out += "\\" + char;
    }
  });
  return out;
}

function cssString(value: string): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\a ")
    .replace(/\r/g, "\\d ");
}

function selectorFromArgs(args: Args): string {
  const elementId = String(args.element_id ?? "");
  const elementName = String(args.element_name ?? "");
  const elementClass = String(args.element_class ?? "");
  let selector = "";
  if (elementId) selector += "#" + cssEscape(elementId);
  if (elementName) selector += `[name="${cssString(elementName)}"]`;
  if (elementClass) {
    for (const item of elementClass.split(/\s+/).filter(Boolean)) {
      selector += "." + cssEscape(item);
    }
  }
  if (!selector) {
    throw new SurferError("At least one of element_id, element_name, element_class is required");
  }
  return selector;
}

// ---------------------------------------------------------------------------
// Page commands
// ---------------------------------------------------------------------------

async function clickElement(args: Args) {
  const selector = selectorFromArgs(args);
  return evaluate(`
    (() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      if (!els.length) return {count: 0, clicked: false};
      const tag = els[0].tagName.toLowerCase();
      els[0].click();
      return {count: els.length, clicked: true, tag};
    })()
  `);
}

async function setElementText(args: Args) {
  const selector = selectorFromArgs(args);
  const value = String(args.text ?? "");
  return evaluate(`
    (() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const value = ${JSON.stringify(value)};
      for (const el of els) {
        if (el.matches('input, textarea')) {
          el.focus();
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) descriptor.set.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        } else if (el.matches('select')) {
          el.focus();
          const option = Array.from(el.options).find(o => o.value === value || o.text === value);
          if (option) el.value = option.value;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        } else if (el.isContentEditable) {
          el.focus();
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText', data: value}));
        } else {
          el.textContent = value;
        }
      }
      return {count: els.length};
    })()
  `);
}

// Page text with ALL links inlined as: "Download Python [url:https://example.org/download]"
const PAGE_CONTENT_EXPRESSION = `
(() => {
  if (!document.body) return '';
  const changed = [];
  const added = [];
  try {
    for (const a of Array.from(document.body.querySelectorAll('a[href]'))) {
      // Show ALL links (including #, javascript:, mailto:, and links without text)
      const raw = a.getAttribute('href') || '';
      let href = raw;
      try { href = new URL(raw, document.baseURI).href; } catch (e) {}

      // Append the URL to the last visible text node of the link so the layout
      // is unchanged (otherwise innerText would put the URL on a separate line).
      const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
      let last = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement;
        if (n.nodeValue.trim() && p && p.getClientRects().length > 0) last = n;
      }
      if (last) {
        changed.push([last, last.nodeValue]);
        last.nodeValue = last.nodeValue.replace(/\\s+$/, '') + ' [url:' + href + ']';
        continue;
      }

      // Link without visible text (icon, image): label from aria-label/title/alt
      const img = a.querySelector('img[alt]');
      const label = (a.getAttribute('aria-label') || a.getAttribute('title') ||
                     (img && img.getAttribute('alt')) || '').trim();
      const span = document.createElement('span');
      span.textContent = (label ? label + ' ' : '') + '[url:' + href + ']';
      a.appendChild(span);
      added.push(span);
    }
    return document.body.innerText || '';
  } finally {
    // Restore the page to its original state
    for (const [node, original] of changed) node.nodeValue = original;
    for (const span of added) span.remove();
  }
})()
`;

async function getPageContent(timeout = 0, limit?: number, offset?: number) {
  await waitForLoad(Number(timeout || 0));
  const text: string = (await evaluate(PAGE_CONTENT_EXPRESSION, 10)) || "";
  const start = offset == null ? 0 : Math.max(0, Math.trunc(offset));
  const size = limit == null ? DEFAULT_TEXT_LIMIT : Math.max(0, Math.trunc(limit));
  const end = start + size;
  return {
    url: await evaluate("location.href"),
    title: await evaluate("document.title"),
    text: text.slice(start, end),
    truncated: end < text.length,
    offset: start,
    total_length: text.length,
  };
}

async function getPageHtml(timeout = 0, limit?: number, offset?: number) {
  await waitForLoad(Number(timeout || 0));
  const html: string =
    (await evaluate("document.documentElement ? document.documentElement.outerHTML : ''", 15)) || "";
  const start = offset == null ? 0 : Math.max(0, Math.trunc(offset));
  const size = limit == null ? DEFAULT_HTML_LIMIT : Math.max(0, Math.trunc(limit));
  const end = start + size;
  return {
    url: await evaluate("location.href"),
    title: await evaluate("document.title"),
    html: html.slice(start, end),
    truncated: end < html.length,
    offset: start,
    total_length: html.length,
  };
}

async function getPageJson(timeout = 0, limit?: number, offset?: number) {
  await waitForLoad(Number(timeout || 0));
  const size = limit == null ? DEFAULT_JSON_LIMIT : Math.max(0, Math.trunc(limit));
  const start = offset == null ? 0 : Math.max(0, Math.trunc(offset));
  return evaluate(
    `
    (() => {
      const all = Array.from(document.querySelectorAll('*'));
      const offset = ${start};
      const elements = all.slice(offset, offset + ${size}).map(el => {
        const attributes = {};
        Array.from(el.attributes).slice(0, 30)
          .forEach(a => attributes[a.name] = a.value);

        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') || '',
          class: typeof el.className === 'string'
            ? el.className : (el.getAttribute('class') || ''),
          text: (el.innerText || el.textContent || '').slice(0, 500),
          value: ('value' in el) ? String(el.value) : '',
          attributes
        };
      });

      const results = Array.from(document.querySelectorAll('a'))
        .filter(a => {
          const r = a.getBoundingClientRect();
          return a.href && a.innerText.trim() &&
                 r.width > 0 && r.height > 0;
        })
        .map(a => ({
          title: a.innerText.trim().slice(0, 300),
          url: a.href,
          text: (a.closest('div')?.innerText || a.innerText)
            .trim().slice(0, 1000)
        }))
        .filter(a => /^https?:/.test(a.url))
        .filter(a => !a.url.includes('google.com/search?'))
        .slice(0, 50);

      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        total_elements: all.length,
        returned_elements: elements.length,
        offset,
        truncated: offset + elements.length < all.length,
        results,
        elements
      };
    })()
  `,
    20,
  );
}

// ---------------------------------------------------------------------------
// Reading a page: inline result or saved to a file
// ---------------------------------------------------------------------------

type PageFormat = "content" | "json" | "html";

const FILE_EXTENSIONS: Record<PageFormat, string> = {
  content: "txt",
  json: "json",
  html: "html",
};

function pageFileName(format: PageFormat, pageUrl: string): string {
  let host = "page";
  try {
    host = new URL(pageUrl).hostname || "page";
  } catch {
    /* ignore */
  }
  host = host.replace(/[^A-Za-z0-9.-]/g, "_").slice(0, 60);
  return `web-surfer-${format}-${host}-${Date.now()}.${FILE_EXTENSIONS[format]}`;
}

// as_file = true: the FULL page is saved to SAVE_PAGE_DIR, limit/offset are ignored,
// and only short metadata plus the file path are returned.
// as_file = false: the (possibly truncated) data is returned inline, honoring limit/offset.
async function readPage(
  format: unknown,
  timeout: number,
  limit: number | undefined,
  offset: number | undefined,
  asFile: boolean,
) {
  const fmt = (format ?? "content") as PageFormat;
  if (fmt !== "content" && fmt !== "json" && fmt !== "html") {
    throw new SurferError('format must be one of: "content", "json", "html"');
  }

  const readLimit = asFile ? NO_LIMIT : limit;
  const readOffset = asFile ? 0 : offset;

  let data: any;
  if (fmt === "content") data = await getPageContent(timeout, readLimit, readOffset);
  else if (fmt === "html") data = await getPageHtml(timeout, readLimit, readOffset);
  else data = await getPageJson(timeout, readLimit, readOffset);

  if (!asFile) return data;

  const body: string =
    fmt === "content" ? data.text : fmt === "html" ? data.html : JSON.stringify(data, null, 2);

  fs.mkdirSync(SAVE_PAGE_DIR, { recursive: true });
  const file = path.join(SAVE_PAGE_DIR, pageFileName(fmt, data.url));
  fs.writeFileSync(file, body, "utf8");

  const meta: Record<string, any> = {
    url: data.url,
    title: data.title,
    format: fmt,
    as_file: true,
    file,
    size_chars: body.length,
    size_bytes: Buffer.byteLength(body, "utf8"),
  };
  if (fmt === "json") {
    meta.total_elements = data.total_elements;
    meta.links_count = Array.isArray(data.results) ? data.results.length : 0;
  }
  meta.note =
    "The page content was saved to the file above and is NOT included in this response. Read the file with your file tools (e.g. read, grep).";
  return meta;
}

// ---------------------------------------------------------------------------
// Browser management
// ---------------------------------------------------------------------------

async function browserStatus() {
  try {
    const version = await httpJson("/json/version", 1);
    return { running: true, cdp_host_port: CDP_HOST_PORT, browser: version.Browser ?? "" };
  } catch {
    return { running: false, cdp_host_port: CDP_HOST_PORT };
  }
}

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(BROWSER_PID_FILE, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePidFile() {
  try {
    fs.unlinkSync(BROWSER_PID_FILE);
  } catch {
    /* ignore */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startBrowser(timeoutSec = 10) {
  if ((await browserStatus()).running) {
    return { started: false, already_running: true };
  }

  let exited = false;
  let child;
  try {
    child = spawn(BROWSER_BIN, BROWSER_ARGS, {
      detached: true,
      stdio: "ignore",
    });
  } catch (exc) {
    throw new SurferError("Cannot start browser: " + exc);
  }
  child.on("error", () => {
    exited = true;
  });
  child.on("exit", () => {
    exited = true;
  });
  child.unref();

  if (child.pid) {
    try {
      fs.writeFileSync(BROWSER_PID_FILE, String(child.pid));
    } catch (exc) {
      throw new SurferError("Cannot write PID file: " + exc);
    }
  }

  if (timeoutSec <= 0) return { started: true, waiting: false, pid: child.pid };

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if ((await browserStatus()).running) {
      // CDP already responds, but the page target may not be ready yet
      try {
        await pageWebSocketUrl();
        if ((await evaluate("document.readyState", 3)) === "complete") {
          return { started: true, running: true, pid: child.pid };
        }
      } catch {
        /* page not ready yet, keep waiting */
      }
    }
    if (exited) {
      removePidFile();
      throw new SurferError("Browser exited during startup. Check BROWSER_BIN and BROWSER_ARGS.");
    }
    await sleep(200);
  }
  return { started: true, running: (await browserStatus()).running, timeout: true, pid: child.pid };
}

async function stopBrowser(timeoutSec = 5) {
  const pid = readPid();
  const running = (await browserStatus()).running;

  if (!running && !(pid && isProcessAlive(pid))) {
    removePidFile();
    return { stopped: false, already_stopped: true };
  }

  try {
    await cdp("Browser.close", {}, 3);
  } catch {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutSec) * 1000;
  while (Date.now() < deadline) {
    const up = (await browserStatus()).running;
    const alive = pid ? isProcessAlive(pid) : false;
    if (!up && !alive) {
      removePidFile();
      return { stopped: true };
    }
    await sleep(200);
  }

  // Last resort: SIGKILL using the PID from the PID file
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  const stopped = !(await browserStatus()).running;
  if (stopped) removePidFile();
  return { stopped, timeout: true };
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

function searchUrl(query: unknown): string {
  return SEARCH_URL + encodeURIComponent(String(query ?? "")).replace(/%20/g, "+");
}

function checkedUrl(value: unknown): string {
  const url = String(value ?? "");
  if (!/^https?:\/\//.test(url)) {
    throw new SurferError("url must start with http:// or https://");
  }
  return url;
}

async function runCommand(command: string, args: Args): Promise<any> {
  const timeout = Math.max(0, Number(args.timeout || 0));
  const { limit, offset } = args;
  const asFile = args.as_file !== false; // default: true
  // *_and_read wait for the page by default
  const readTimeout = args.timeout == null ? DEFAULT_READ_TIMEOUT : timeout;

  return withCommandLock(async () => {
    switch (command) {
      case "search": {
        const url = searchUrl(args.query);
        await navigate(url, timeout);
        return { url, note: NAVIGATION_NOTE };
      }
      case "go_to_url": {
        const url = checkedUrl(args.url);
        await navigate(url, timeout);
        return { url, note: NAVIGATION_NOTE };
      }
      case "search_and_read": {
        await navigate(searchUrl(args.query), readTimeout);
        return readPage(args.format, readTimeout, limit, offset, asFile);
      }
      case "go_to_url_and_read": {
        await navigate(checkedUrl(args.url), readTimeout);
        return readPage(args.format, readTimeout, limit, offset, asFile);
      }
      case "click_element":
        return clickElement(args);
      case "set_element_text":
        return setElementText(args);
      case "get_page_content":
        return readPage("content", timeout, limit, offset, asFile);
      case "get_page_json":
        return readPage("json", timeout, limit, offset, asFile);
      case "get_page_html":
        return readPage("html", timeout, limit, offset, asFile);
      case "get_page_title":
        await waitForLoad(timeout);
        return { url: await evaluate("location.href"), title: await evaluate("document.title") };
      case "start_browser":
        return startBrowser(Number(args.timeout ?? 10));
      case "stop_browser":
        return stopBrowser(Number(args.timeout ?? 5));
      case "get_browser_status":
        return browserStatus();
      default:
        throw new SurferError("Unknown command: " + command);
    }
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  function register(
    name: string,
    description: string,
    parameters: ReturnType<typeof Type.Object>,
  ) {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      async execute(_id, params) {
        try {
          const result = await runCommand(name, params as Args);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, result }) }],
          };
        } catch (exc) {
          throw new Error(`Web Surfer: ${exc instanceof Error ? exc.message : String(exc)}`);
        }
      },
    });
  }

  const timeout = Type.Optional(
    Type.Number({
      description:
        "Page load timeout in seconds (waits until readyState === \"complete\"). If omitted or 0, the command does not wait for the page to load, so the page may still be empty. After search/go_to_url and before get_page_*, passing a timeout (e.g. 10) is recommended",
    }),
  );

  const limit = Type.Optional(
    Type.Number({
      description:
        "Maximum amount of data to return (characters for get_page_content/get_page_html, elements for get_page_json); if omitted, a built-in limit applies. Ignored when as_file=true",
    }),
  );

  const offset = Type.Optional(
    Type.Number({
      description:
        "Offset to start returning data from (characters for get_page_content/get_page_html, elements for get_page_json). Use it to fetch the tail when the output was truncated. Ignored when as_file=true",
    }),
  );

  const asFile = Type.Optional(
    Type.Boolean({
      description: `Default true: the full page content is saved to a file (directory ${SAVE_PAGE_DIR}) and only short metadata plus the file path are returned; limit and offset are ignored in this case. Pass false to get the content directly in the response (honoring limit/offset) — this consumes context, so use it only for small amounts of data`,
    }),
  );

  const format = Type.Optional(
    Type.Union(
      [Type.Literal("content"), Type.Literal("json"), Type.Literal("html")],
      {
        description:
          'Content format: "content" (page text with links as [url:...], default), "json" (DOM as JSON, like get_page_json) or "html" (like get_page_html)',
      },
    ),
  );

  register(
    "search",
    "Search the web via the browser. Performs navigation to the results page only and returns the navigation status, NOT the page content. To read the results, call get_page_content (or get_page_json) as a SEPARATE call AFTER search has finished, not in parallel. Pass timeout (e.g. 10) to wait for the page to load. To search and read in a single call, use search_and_read",
    Type.Object({
      query: Type.String(),
      timeout,
    }),
  );

  register(
    "go_to_url",
    "Open a URL in the browser. Performs navigation only and returns the navigation status, NOT the page content. To read the page, call get_page_content (or get_page_json) as a SEPARATE call AFTER go_to_url has finished, not in parallel. Pass timeout (e.g. 10) to wait for the page to load. To open and read in a single call, use go_to_url_and_read",
    Type.Object({
      url: Type.String(),
      timeout,
    }),
  );

  register(
    "search_and_read",
    `Search the web and read the results page in a single call (navigation, waiting for load, reading). The format is set with the format parameter: content (default) / json / html. Default timeout is 10 seconds. By default (as_file=true) the content is saved to a file in ${SAVE_PAGE_DIR} and only metadata plus the file path are returned`,
    Type.Object({
      query: Type.String(),
      format,
      as_file: asFile,
      timeout,
      limit,
      offset,
    }),
  );

  register(
    "go_to_url_and_read",
    `Open a URL and read the page in a single call (navigation, waiting for load, reading). The format is set with the format parameter: content (default) / json / html. Default timeout is 10 seconds. By default (as_file=true) the content is saved to a file in ${SAVE_PAGE_DIR} and only metadata plus the file path are returned`,
    Type.Object({
      url: Type.String(),
      format,
      as_file: asFile,
      timeout,
      limit,
      offset,
    }),
  );

  register(
    "get_page_json",
    "Get the page DOM as JSON. By default (as_file=true) it is saved to a file and only metadata plus the file path are returned",
    Type.Object({
      as_file: asFile,
      timeout,
      limit,
      offset,
    }),
  );

  register(
    "get_page_content",
    "Get the page text; all links are inlined as \"Link text [url:https://...]\" (links without text appear as \"[url:...]\", with a label from aria-label/title/alt if available). Pass timeout (e.g. 10) to wait for the page to fully load, otherwise the text may be empty. By default (as_file=true) it is saved to a file and only metadata plus the file path are returned",
    Type.Object({
      as_file: asFile,
      timeout,
      limit,
      offset,
    }),
  );

  register(
    "get_page_html",
    "Get the page HTML. By default (as_file=true) it is saved to a file and only metadata plus the file path are returned",
    Type.Object({
      as_file: asFile,
      timeout,
      limit,
      offset,
    }),
  );

  register("get_page_title", "Get the page title", Type.Object({
    timeout,
  }));

  register("click_element", "Click an element by ID, name or class", Type.Object({
    element_id: Type.Optional(Type.String()),
    element_name: Type.Optional(Type.String()),
    element_class: Type.Optional(Type.String()),
    timeout,
  }));

  register("set_element_text", "Enter text into a page element", Type.Object({
    element_id: Type.Optional(Type.String()),
    element_name: Type.Optional(Type.String()),
    element_class: Type.Optional(Type.String()),
    text: Type.String(),
    timeout,
  }));

  register("start_browser", "Start the browser", Type.Object({
    timeout,
  }));

  register("stop_browser", "Stop the browser", Type.Object({}));

  register("get_browser_status", "Check the browser status", Type.Object({}));
}
