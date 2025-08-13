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

// ---------- Lanzador con stealth + sesión persistente + proxy opcional ----------
async function launchBrowser() {
  const userDataDir = process.env.USER_DATA_DIR || "/usr/src/app/.chromedata";
  const args = [
    "--no-sandbox","--disable-setuid-sandbox",
    "--disable-dev-shm-usage","--no-zygote","--single-process",
    "--window-size=1366,768"
  ];
  if (process.env.PROXY_URL) args.push(`--proxy-server=${process.env.PROXY_URL}`);

  return puppeteerExtra.launch({
    executablePath: puppeteer.executablePath(),
    headless: true,
    args,
    userDataDir
  });
}

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
  // Autenticación de proxy si aplica
  if (process.env.PROXY_USERNAME) {
    await page.authenticate({
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD || ""
    });
  }
}

// ---------- Navegación robusta con retries / fallbacks ----------
async function getHtmlRobusto(url) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await preparePage(page);

  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(20000);

  let lastError;
  for (const waitUntil of ["networkidle2", "domcontentloaded"]) {
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const resp = await page.goto(url, { waitUntil, timeout: 45000 });

        // esperar si hay “verificando su navegador…”
        await Promise.race([
          page.waitForFunction(
            () => !/just a moment|please wait|verifying|checking your browser|ser humano/i.test(document.body.innerText),
            { timeout: 15000 }
          ),
          page.waitForTimeout(8000)
        ]).catch(() => {});

        await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
        const html = await page.content();

        const status = resp?.status?.() ?? 200;
        if ([403, 429, 503].includes(status)) throw new Error(`HTTP ${status}`);
        if (/just a moment|please wait|checking your browser|ser humano/i.test(html))
          throw new Error("Anti-bot challenge detectado");

        await browser.close();
        return html;
      } catch (e) {
        lastError = e;
        await new Promise(r => setTimeout(r, 1000 * intento)); // backoff
      }
    }
  }

  await browser.close().catch(() => {});
  throw lastError ?? new Error("Fallo al obtener HTML");
}

// ---------- RUTA: HTML completo ----------
app.get("/html", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !isHttpUrl(url)) return res.status(400).json({ ok:false, error:"Parámetro 'url' inválido" });
    const html = await getHtmlRobusto(url);
    res.json({ ok:true, url, html });
  } catch (e) {
    console.error("[/html]", e);
    res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// (deja también tus /screenshot y /pdf como ya están)

// Timeouts del servidor altos para evitar 502 por cortes tempranos
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Puppeteer service listening on :${PORT}`));
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;
server.requestTimeout = 120000;
