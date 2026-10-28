/**
 * The screenshots and the animation of the README, taken from the app running
 * with the real corpus: `npm run dev` in one terminal, `npm run screenshots` in
 * another. They land in `docs/screenshots/`.
 *
 * Every answer is a real call to the chat model, four in all: under the limit
 * of five a minute for one client. The animation needs ffmpeg
 * (`sudo apt install ffmpeg`); without it, its frames are left as images.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

const BASE_URL = process.env.SCREENSHOTS_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";
/** Time between two frames of the animation. */
const FRAME_MS = 150;
/** A local model writes slowly, and the first answer waits for it to load. */
const ANSWER_TIMEOUT_MS = 180_000;

const QUESTIONS = {
  amounts:
    "Tope de la retribución de los agentes habilitados para realizar servicios extraordinarios a partir del 1° de junio de 2026",
  english: "Which law approves the amendment to the tax treaty with France?",
  filtered: "Convenio de seguridad social con la República de San Marino",
  streaming:
    "Adicional por prestación de servicios en la Antártida para el personal militar",
};

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 900 } };
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

/** Opens a page of the app, without the development tools of `next dev`. */
async function open(page: Page, path: string) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

/** Waits for the line that says who wrote the answer: it is shown when it ends. */
async function answered(page: Page) {
  await page
    .getByText(/^(Respuesta de|Answer by) /)
    .first()
    .waitFor({ timeout: ANSWER_TIMEOUT_MS });
  // The sources that were not cited fade out after the answer ends.
  await page.waitForTimeout(500);
}

async function ask(page: Page, question: string) {
  await page.locator("#question").fill(question);
  await page.locator("button[type=submit]").click();
  await answered(page);
}

async function shot(
  browser: Browser,
  name: string,
  options: BrowserContextOptions,
  take: (page: Page) => Promise<void>,
  fullPage = true,
) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  try {
    await take(page);
    await page.screenshot({ path: join(OUT, name), fullPage });
    console.log(`  ${name}`);
  } finally {
    await context.close();
  }
}

/**
 * Screenshots of a page, one after another, until `done` settles. Taking one
 * takes time too: the rate they were taken at is returned, so the GIF plays
 * at the speed it happened.
 */
async function frames(
  page: Page,
  dir: string,
  done: Promise<unknown>,
): Promise<number> {
  const started = Date.now();
  let finished = false;
  void done.finally(() => (finished = true));
  let count = 0;
  while (!finished) {
    await page.screenshot({ path: join(dir, `${String(count).padStart(4, "0")}.png`) });
    count += 1;
    await page.waitForTimeout(FRAME_MS);
  }
  return count / ((Date.now() - started) / 1000);
}

/**
 * A question being typed and answered, as a GIF: frames taken while it
 * happens, joined by ffmpeg.
 */
async function animation(browser: Browser) {
  const dir = join(OUT, "frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
  const page = await context.newPage();
  let rate = 1000 / FRAME_MS;

  try {
    await open(page, "/es");
    const scene = (async () => {
      await page.waitForTimeout(600);
      await page
        .locator("#question")
        .pressSequentially(QUESTIONS.streaming, { delay: 35 });
      await page.locator("button[type=submit]").click();
      await answered(page);
      // The end stays on screen for a moment before the GIF starts over.
      await page.waitForTimeout(2_500);
    })();
    rate = await frames(page, dir, scene);
    await scene;
  } finally {
    await context.close();
  }

  const gif = join(OUT, "answer.gif");
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      rate.toFixed(2),
      "-i",
      join(dir, "%04d.png"),
      "-vf",
      "scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none",
      gif,
    ],
    { stdio: "inherit" },
  );
  if (ffmpeg.error || ffmpeg.status !== 0) {
    console.log(
      `  no GIF: ffmpeg is not available (sudo apt install ffmpeg). The frames are in ${dir}`,
    );
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("  answer.gif");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  console.log(`From ${BASE_URL}, into ${OUT}:`);

  try {
    await shot(browser, "answer-es.png", DESKTOP, async (page) => {
      await open(page, "/es");
      await ask(page, QUESTIONS.amounts);
    });

    await shot(
      browser,
      "answer-en-dark.png",
      { ...DESKTOP, colorScheme: "dark" },
      async (page) => {
        await open(page, "/en");
        await ask(page, QUESTIONS.english);
      },
    );

    // A shared link with filters, on a phone: it opens with its answer.
    await shot(
      browser,
      "filters-phone.png",
      PHONE,
      async (page) => {
        const query = new URLSearchParams({ q: QUESTIONS.filtered, type: "Ley" });
        await open(page, `/es?${query}`);
        await answered(page);
      },
      false,
    );

    await animation(browser);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(`Is the app running at ${BASE_URL}? Start it with \`npm run dev\`.`);
  process.exit(1);
});
