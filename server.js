import express from "express";
import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

function isHttpUrl(url) {
  try { const u = new URL(url); return ["http:", "https:"].includes(u.protocol); }
  catch { return false; }
}

// ===== Lanzar Chrome con stealth + proxy opcional =====
async function launchBrowser() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--single-process"
  ];
  if (process.env.PROXY_URL) args.push(`--proxy-server=${process.env.PROXY_URL}`);

  return puppeteerExtra.launch({
    executablePath: puppeteer.executablePath(),
    headless: true,
    args
  });
}

// ===== Preparación de página (UA, idioma, tz) =====
async function preparePage(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
    "referer": "https://www.google.com/"
  });
  try { await page.emulateTimezone("America/Lima"); } catch {}
  // IMPORTANTE: no bloqueamos imágenes/recursos aquí para no romper challenges
}

// ===== Navegación robusta con retries y fallbacks =====
async function getHtmlRobusto(url) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await preparePage(page);

  // timeouts razonables
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(20000);

  let lastError;
  for (const waitUntil of ["networkidle2", "domcontentloaded"]) {
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const resp = await page.goto(url, { waitUntil, timeout: 45000 });

        // si hay challenge tipo "Just a moment..." espera un rato y vuelve a leer
        await Promise.race([
          page.waitForFunction(
            () => !/just a moment|please wait|verifying|checking your browser/i.test(document.body.innerText),
            { timeout: 12000 }
          ),
          page.waitForTimeout(6000)
        ]).catch(() => {});

        await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
        const html = await page.content();
        await browser.close();

        // si devolvió directamente la página de challenge, forzamos retry
        if (/just a moment|please wait|checking your browser/i.test(html)) {
          throw new Error("Anti-bot challenge detectado");
        }

        // si la respuesta fue 403/503, retry
        const status = resp?.status?.() ?? 200;
        if ([403, 429, 503].includes(status)) {
          throw new Error(`HTTP ${status}`);
        }

        return html;
      } catch (e) {
        lastError = e;
        // pequeño backoff
        await new Promise(r => setTimeout(r, 1000 * intento));
      }
    }
  }

  await browser.close().catch(() => {});
  throw lastError ?? new Error("Fallo al obtener HTML");
}

// ======= RUTA: HTML completo =======
app.get("/html", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ ok: false, error: "Parámetro 'url' inválido" });
    }
    const html = await getHtmlRobusto(url);
    res.json({ ok: true, url, html });
  } catch (e) {
    console.error("[/html]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// (tus rutas GET /scrape, /screenshot, /pdf pueden quedarse como estaban)

// ====== servidor y timeouts altos ======
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Puppeteer service listening on :${PORT}`);
});
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;
server.requestTimeout = 120000;
