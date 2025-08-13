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

// >>> NUEVO: lanzar con puppeteer-extra + flags + proxy opcional
async function launchBrowser() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--single-process",
  ];
  if (process.env.PROXY_URL) args.push(`--proxy-server=${process.env.PROXY_URL}`);

  return puppeteerExtra.launch({
    executablePath: puppeteer.executablePath(), // usa Chrome que baja Puppeteer
    headless: true,
    args
  });
}

// >>> NUEVO: preparar la página con cabeceras/UA/idioma/tiempo
async function preparePage(page) {
  // UA realista
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

  // Idioma + orden de headers "humanos"
  await page.setExtraHTTPHeaders({
    "accept-language": "es-ES,es;q=0.9,en;q=0.8"
  });

  // Zona horaria local (reduce señales de automatización)
  try { await page.emulateTimezone("America/Lima"); } catch {}

  // (Opcional) bloquear recursos pesados si sólo quieres HTML
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "media", "font"].includes(type)) return req.abort();
    req.continue();
  });
}

// ================= RUTAS =================

// GET /html?url=...
app.get("/html", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !isHttpUrl(url)) return res.status(400).json({ error: "Parámetro 'url' inválido" });

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await preparePage(page);

    // Estrategia de navegación con fallback
    let html;
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    } catch {
      // Si la red nunca “se queda quieta”, intenta DOMContentLoaded
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    }

    // Espera mínima a que el framework hidrate (si aplica)
    await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
    html = await page.content();

    await browser.close();
    res.json({ ok: true, url, html });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// (Tus rutas GET existentes) /scrape, /screenshot, /pdf …
// Si quieres mantener /scrape GET tal cual, no lo toques.
