import express from "express";
import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

/* -------------------- helpers -------------------- */
function isHttpUrl(u) {
  try {
    const x = new URL(u);
    return ["http:", "https:"].includes(x.protocol);
  } catch {
    return false;
  }
}

// Chequeo simple de robots.txt (bloques para User-agent: *)
async function isAllowedByRobots(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const robotsUrl = `${u.origin}/robots.txt`;
    const r = await fetch(robotsUrl, { cache: "no-store" });
    if (!r.ok) return true; // si no hay robots, no bloqueamos
    const txt = await r.text();
    const lines = txt.split(/\r?\n/);

    let active = false;
    const allows = [];
    const disallows = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (/^user-agent:/i.test(line)) {
        const agent = line.split(":")[1].trim().toLowerCase();
        active = agent === "*";
        continue;
      }
      if (!active) continue;
      if (/^allow:/i.test(line)) allows.push(line.split(":")[1].trim());
      if (/^disallow:/i.test(line)) disallows.push(line.split(":")[1].trim());
    }

    const pathQ = u.pathname + (u.search || "");
    const match = (pattern) => {
      if (pattern === undefined) return false;
      if (pattern === "" || pattern === "/") return true;
      const esc = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*");
      const re = new RegExp(`^${esc}${pattern.endsWith("$") ? "$" : ""}`);
      return re.test(pathQ);
    };

    // si algún Allow matchea, gana sobre Disallow
    if (allows.some(match)) return true;
    if (disallows.some(match)) return false;
    return true;
  } catch {
    return true;
  }
}

// Lanzar Chrome con stealth (+proxy opcional) y sesión persistente
async function launchBrowser() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--no-zygote",
    "--single-process",
    "--window-size=1366,768"
  ];
  if (process.env.PROXY_URL) args.push(`--proxy-server=${process.env.PROXY_URL}`);

  return puppeteerExtra.launch({
    executablePath: puppeteer.executablePath(),
    headless: true,
    args,
    userDataDir: process.env.USER_DATA_DIR || "/usr/src/app/.chromedata"
  });
}

async function preparePage(page) {
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
    referer: "https://www.google.com/"
  });
  try {
    await page.emulateTimezone("America/Lima");
  } catch {}
  // auth para proxy si aplica
  if (process.env.PROXY_USERNAME) {
    await page.authenticate({
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD || ""
    });
  }
}

// Primer intento local (stealth + fallbacks)
async function tryLocalHtml(url) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await preparePage(page);
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(20000);

  let lastErr;
  for (const waitUntil of ["networkidle2", "domcontentloaded"]) {
    for (let intento = 1; intento <= 2; intento++) {
      try {
        const resp = await page.goto(url, { waitUntil, timeout: 45000 });

        // esperar si hay challenge “verificando / just a moment…”
        await Promise.race([
          page.waitForFunction(
            () =>
              !/just a moment|please wait|checking your browser|ser humano/i.test(
                document.body.innerText
              ),
            { timeout: 15000 }
          ),
          page.waitForTimeout(8000)
        ]).catch(() => {});

        await page.waitForSelector("body", { timeout: 10000 }).catch(() => {});
        const html = await page.content();

        const status = resp?.status?.() ?? 200;
        if ([403, 429, 503].includes(status))
          throw new Error(`HTTP ${status}`);
        if (
          /just a moment|please wait|checking your browser|ser humano/i.test(html)
        )
          throw new Error("Anti-bot challenge detectado");

        await browser.close();
        return html;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * intento));
      }
    }
  }
  await browser.close().catch(() => {});
  throw lastErr ?? new Error("Local fail");
}

// Fallback a proveedor anti-bot (ejemplo: ScraperAPI)
async function tryProviderHtml(url) {
  const key = process.env.SCRAPERAPI_KEY; // pon tu key en Railway
  if (!key) throw new Error("No SCRAPERAPI_KEY set");
  const apiUrl = `https://api.scraperapi.com?api_key=${key}&render=true&country=pe&keep_headers=true&url=${encodeURIComponent(
    url
  )}`;

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 60000);
  const r = await fetch(apiUrl, { signal: ac.signal });
  clearTimeout(to);
  if (!r.ok) throw new Error(`Provider HTTP ${r.status}`);
  return await r.text();
}

/* -------------------- rutas -------------------- */

// HTML completo (GET)
app.get("/html", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !isHttpUrl(url))
      return res.status(400).json({ ok: false, error: "Parámetro 'url' inválido" });

    if (!(await isAllowedByRobots(url))) {
      return res
        .status(403)
        .json({ ok: false, error: "Bloqueado por robots.txt" });
    }

    try {
      const html = await tryLocalHtml(url);
      return res.json({ ok: true, source: "local", url, html });
    } catch (localErr) {
      try {
        const html = await tryProviderHtml(url);
        return res.json({ ok: true, source: "provider", url, html });
      } catch (providerErr) {
        return res
          .status(502)
          .json({
            ok: false,
            error: `${localErr.message} | provider: ${providerErr.message}`
          });
      }
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// HTML completo (POST) { url: "..."}
app.post("/html", async (req, res) => {
  const { url } = req.body || {};
  req.query.url = url;
  return app._router.handle(req, res, require("http").METHODS.includes("GET") ? "GET" : "GET");
});

// Screenshot PNG (para pruebas)
app.get("/screenshot", async (req, res) => {
  try {
    const { url, fullPage } = req.query;
    if (!url || !isHttpUrl(url))
      return res.status(400).json({ error: "Parámetro 'url' inválido" });

    if (!(await isAllowedByRobots(url))) {
      return res
        .status(403)
        .json({ error: "Bloqueado por robots.txt" });
    }

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await preparePage(page);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    }

    const buf = await page.screenshot({
      type: "png",
      fullPage:
        String(fullPage) === "1" || String(fullPage).toLowerCase() === "true"
    });

    await browser.close();
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* -------------------- server -------------------- */
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`Puppeteer service listening on :${PORT}`)
);
// evitar 502 por timeouts cortos en edge
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;
server.requestTimeout = 120000;
