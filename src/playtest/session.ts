import type { Browser, Page } from 'playwright-core';
import { findChromium } from './chromium.js';
import { ENGINE_DRIVER } from './driver.js';
import { startStaticServer, StaticServer } from './staticServer.js';

/**
 * One headless run of the game: a static server over the project, a Chromium
 * page booted into `index.html`, and the in-page `__mcp` driver installed. Used
 * by `render_map` and `run_playtest`; always closed in a `finally`.
 */

/** RPG Maker MV's default screen size — the viewport for a normal (non-whole-map) view. */
export const DEFAULT_VIEWPORT = { width: 816, height: 624 };

const CHROMIUM_ARGS = [
  // WebGL in a headless shell with no GPU: ANGLE over SwiftShader.
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
];

type PlaywrightModule = typeof import('playwright-core');

/**
 * Load `playwright-core` lazily. It is an optional dependency: the other ~120
 * tools never need a browser, so a failed optional install must not break the
 * server — only these tools, with a message that says how to fix it.
 */
export async function loadPlaywright(): Promise<PlaywrightModule> {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('Headless rendering requires Node.js 20 or newer for playwright-core; the other MV tools remain available on Node.js 18.');
  }
  try {
    const mod = (await import('playwright-core')) as PlaywrightModule & {
      default?: PlaywrightModule;
    };
    return mod.chromium ? mod : (mod.default as PlaywrightModule);
  } catch {
    throw new Error(
      'Headless rendering needs the optional dependency "playwright-core", which is not installed. ' +
        'Install it next to the server (`npm install playwright-core`) and make sure a Chromium is available ' +
        '(`npx playwright install chromium-headless-shell`).',
    );
  }
}

export interface EngineSession {
  page: Page;
  /** console.error / uncaught page errors / HTTP >= 400 (missing assets), in order. */
  problems: string[];
  /** Evaluate `__mcp.<fn>(...args)` in the page. */
  call: <T = unknown>(fn: string, ...args: unknown[]) => Promise<T>;
  /** Evaluate page JavaScript with server-shutdown cancellation. */
  evaluate: <T = unknown>(script: string) => Promise<T>;
  /** Poll `__mcp.<fn>(...args)` until truthy, or throw `what` after `timeoutMs`. */
  waitFor: (what: string, fn: string, args?: unknown[], timeoutMs?: number) => Promise<void>;
  /** Tap a virtual button (`ok`, `cancel`, `down`, …) by toggling engine input state. */
  press: (button: string, holdMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

interface ActiveSession {
  cancel: () => void;
  close: () => Promise<void>;
}
const activeSessions = new Set<ActiveSession>();

/** Close only browsers/static servers owned by this MCP process. */
export async function stopHeadlessSessions(): Promise<void> {
  const sessions = [...activeSessions];
  for (const session of sessions) session.cancel();
  await Promise.allSettled(sessions.map((session) => session.close()));
}

/** Build the page-side expression `__mcp.fn(<json args>)`. */
export function driverCall(fn: string, args: unknown[]): string {
  if (!/^[A-Za-z_]\w*$/.test(fn)) throw new Error(`Bad driver function name: ${fn}`);
  return `__mcp.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`;
}

export async function openSession(
  projectPath: string,
  opts: { viewport?: { width: number; height: number }; bootTimeoutMs?: number } = {},
): Promise<EngineSession> {
  let server: StaticServer | undefined;
  let browser: Browser | undefined;
  let cancelled = false;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  // Closing an idle session must not create an unhandled rejection.
  void cancellation.catch(() => undefined);
  const race = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, cancellation]);
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    rejectCancellation(new Error('Headless session cancelled: server is shutting down or the session was closed.'));
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    cancel();
    closing ??= (async () => {
      await browser?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      activeSessions.delete(active);
    })();
    return closing;
  };
  const active = { cancel, close };
  activeSessions.add(active);
  try {
    const playwright = await race(loadPlaywright());
    const executablePath = findChromium();
    const openedServer = await race(startStaticServer(projectPath).then(async (opened) => {
      if (cancelled) { await opened.close(); throw new Error('Headless startup cancelled.'); }
      server = opened;
      return opened;
    }));
    const openedBrowser = await race(playwright.chromium.launch({ executablePath, args: CHROMIUM_ARGS }).then(async (opened) => {
      if (cancelled) { await opened.close(); throw new Error('Headless startup cancelled.'); }
      browser = opened;
      return opened;
    }));
    const page = await race(openedBrowser.newPage({ viewport: opts.viewport ?? DEFAULT_VIEWPORT }));
    const problems: string[] = [];
    page.on('console', (m) => {
      // The browser's own "Failed to load resource" line duplicates the HTTP
      // entry below, which names the file — keep only that one.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) {
        problems.push(`[console.error] ${m.text()}`);
      }
    });
    page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) {
        problems.push(`[HTTP ${r.status()}] ${decodeURIComponent(new URL(r.url()).pathname)}`);
      }
    });
    await race(page.addInitScript({ content: ENGINE_DRIVER }));

    const evaluate = <T>(script: string): Promise<T> => race(page.evaluate(script)) as Promise<T>;
    const call = <T>(fn: string, ...args: unknown[]): Promise<T> =>
      evaluate(driverCall(fn, args));
    const waitFor = async (what: string, fn: string, args: unknown[] = [], timeoutMs = 20000) => {
      try {
        await race(page.waitForFunction(driverCall(fn, args), undefined, {
          timeout: timeoutMs,
          polling: 50,
        }));
      } catch (e) {
        const reason = e instanceof Error ? e.message.split('\n')[0] : String(e);
        const recent = problems.slice(-5).join(' | ');
        throw new Error(
          `Timed out waiting for ${what} (${reason}).${recent ? ` Recent page problems: ${recent}` : ''}`,
        );
      }
    };
    const press = async (button: string, holdMs = 60) => {
      const b = JSON.stringify(button);
      await page.evaluate(`Input._currentState[${b}] = true`);
      await page.waitForTimeout(holdMs);
      await page.evaluate(`Input._currentState[${b}] = false`);
      await page.waitForTimeout(60);
    };

    await race(page.goto(`${openedServer.origin}/index.html`));
    await waitFor('the game to boot', 'booted', [], opts.bootTimeoutMs ?? 30000);
    await call('init');

    return {
      page,
      problems,
      call,
      evaluate,
      waitFor,
      press,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
