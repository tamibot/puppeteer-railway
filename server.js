import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ]
  });
}

app.get("/scrape", async (req, res) => {
  try {
    const { url, selector = "body", all } = req.query;
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ error: "Parámetro 'url' inválido" });
    }

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
    );
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    let data;
    if (all) {
      data = await page.$$eval(selector, els => els.map(e => e.textContent?.trim() || ""));
    } else {
      data = await page.$eval(selector, el => el.textContent?.trim() || "");
    }

    await browser.close();
    res.json({ url, selector, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/screenshot", async (req, res) => {
  try {
    const { url, fullPage } = req.query;
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ error: "Parámetro 'url' inválido" });
    }

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const buffer = await page.screenshot({ type: "png", fullPage: Boolean(fullPage) });
    await browser.close();

    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/pdf", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !isHttpUrl(url)) {
      return res.status(400).json({ error: "Parámetro 'url' inválido" });
    }

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const pdf = await page.pdf({
      printBackground: true,
      format: "A4",
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" }
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Puppeteer service listening on :${PORT}`);
});
