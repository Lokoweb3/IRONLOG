// ---------------------------------------------------------------------------
//  FOOD SEARCH (require auth) — proxies an external nutrition database so the
//  API key/CORS/normalization stay server-side. Default provider is Open Food
//  Facts (keyless). To swap to USDA/Nutritionix later, only `searchProvider`
//  below needs to change — the route + response shape stay the same.
//
//  Normalized result shape:
//    { id, name, brand, per100g: { calories, protein, carbs, fat }, servingG }
// ---------------------------------------------------------------------------
import { Router } from "express";

export const foodsRouter = Router();

const round = (v) => (v == null || isNaN(v) ? null : Math.round(v * 10) / 10);
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

async function searchOpenFoodFacts(query) {
  // Open Food Facts "search-a-licious" API — keyless and, unlike the legacy
  // cgi/search.pl endpoint, it doesn't 503 datacenter/server IPs.
  const url =
    "https://search.openfoodfacts.org/search?" +
    new URLSearchParams({
      q: query,
      page_size: "25",
      fields: "code,product_name,brands,nutriments,serving_quantity",
    });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  let data;
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "IRONLOG/1.0 (workout + macro tracker)" },
    });
    if (!r.ok) throw new Error(`OFF ${r.status}`);
    data = await r.json();
  } finally {
    clearTimeout(t);
  }

  const hits = Array.isArray(data?.hits) ? data.hits : [];
  return hits
    .map((p, i) => {
      const n = p.nutriments || {};
      let kcal = num(n["energy-kcal_100g"]);
      if (kcal == null && n["energy_100g"] != null) kcal = num(n["energy_100g"]) / 4.184; // kJ -> kcal
      const brand = Array.isArray(p.brands) ? p.brands[0] : (p.brands || "").split(",")[0];
      return {
        id: p.code || `off-${i}`,
        name: (p.product_name || "").trim(),
        brand: (brand || "").trim(),
        per100g: {
          calories: round(kcal),
          protein: round(num(n.proteins_100g)),
          carbs: round(num(n.carbohydrates_100g)),
          fat: round(num(n.fat_100g)),
        },
        servingG: round(num(p.serving_quantity)),
      };
    })
    .filter((r) => r.name && r.per100g.calories != null);
}

// Look up a single product by barcode (UPC/EAN) via the OFF product API.
async function barcodeOpenFoodFacts(code) {
  const url =
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?` +
    new URLSearchParams({ fields: "code,product_name,brands,nutriments,serving_quantity" });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  let data;
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "IRONLOG/1.0 (workout + macro tracker)" },
    });
    if (!r.ok) throw new Error(`OFF ${r.status}`);
    data = await r.json();
  } finally {
    clearTimeout(t);
  }

  if (data?.status !== 1 || !data.product) return null;
  const p = data.product;
  const n = p.nutriments || {};
  let kcal = num(n["energy-kcal_100g"]);
  if (kcal == null && n["energy_100g"] != null) kcal = num(n["energy_100g"]) / 4.184;
  const name = (p.product_name || "").trim();
  if (!name || kcal == null) return null;
  const brand = Array.isArray(p.brands) ? p.brands[0] : (p.brands || "").split(",")[0];
  return {
    id: p.code || code,
    name,
    brand: (brand || "").trim(),
    per100g: {
      calories: round(kcal),
      protein: round(num(n.proteins_100g)),
      carbs: round(num(n.carbohydrates_100g)),
      fat: round(num(n.fat_100g)),
    },
    servingG: round(num(p.serving_quantity)),
  };
}

/* ----------------------- USDA FoodData Central --------------------------- */
// Far better coverage of US branded groceries (incl. barcodes) than OFF. Uses a
// free API key via FOOD_API_KEY; falls back to the rate-limited DEMO_KEY so it
// still works out of the box. Get a key: https://fdc.nal.usda.gov/api-key-signup.html
const FOOD_API_KEY = process.env.FOOD_API_KEY || "DEMO_KEY";

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "IRONLOG/1.0 (workout + macro tracker)" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// USDA descriptions are often ALL CAPS — gently title-case those for display.
function prettify(s) {
  const str = String(s || "").trim();
  return str && str === str.toUpperCase()
    ? str.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    : str;
}

function normalizeUSDA(f) {
  if (!f) return null;
  const nutr = {};
  for (const n of f.foodNutrients || []) {
    if (n.nutrientNumber != null) nutr[String(n.nutrientNumber)] = n.value;
  }
  let kcal = num(nutr["208"]);
  if (kcal == null && nutr["268"] != null) kcal = num(nutr["268"]) / 4.184; // kJ -> kcal
  const name = prettify(f.description);
  if (!name || kcal == null) return null;
  let servingG = null;
  if (f.servingSize && /^(g|ml|grm|mlt)$/i.test(f.servingSizeUnit || "")) servingG = num(f.servingSize);
  return {
    id: f.gtinUpc || `fdc-${f.fdcId}`,
    name,
    brand: prettify(f.brandOwner || f.brandName || ""),
    per100g: {
      calories: round(kcal),
      protein: round(num(nutr["203"])),
      carbs: round(num(nutr["205"])),
      fat: round(num(nutr["204"])),
    },
    servingG: round(servingG),
  };
}

async function searchUSDA(query) {
  const url =
    "https://api.nal.usda.gov/fdc/v1/foods/search?" +
    new URLSearchParams({ api_key: FOOD_API_KEY, query, dataType: "Branded,Foundation,SR Legacy", pageSize: "25" });
  const data = await fetchJson(url);
  const foods = Array.isArray(data?.foods) ? data.foods : [];
  return foods.map(normalizeUSDA).filter(Boolean);
}

async function barcodeUSDA(code) {
  const url =
    "https://api.nal.usda.gov/fdc/v1/foods/search?" +
    new URLSearchParams({ api_key: FOOD_API_KEY, query: code, dataType: "Branded", pageSize: "10" });
  const data = await fetchJson(url);
  const foods = Array.isArray(data?.foods) ? data.foods : [];
  const strip = (s) => String(s || "").replace(/^0+/, "");
  // only accept an exact UPC match so we never show the wrong product
  const match = foods.find((f) => strip(f.gtinUpc) === strip(code));
  return normalizeUSDA(match);
}

// the single swap point for changing providers
const searchProvider = searchOpenFoodFacts;
const barcodeProvider = barcodeOpenFoodFacts;

// GET /foods/search?q=chicken -> { results: [...] }
foodsRouter.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ results: [] });
  let results = [];
  try { results = await searchProvider(q); } catch (e) { console.error("[foods] OFF search failed:", e.message); }
  if (!results.length) {
    try { results = await searchUSDA(q); } catch (e) { console.error("[foods] USDA search failed:", e.message); }
  }
  res.json({ results: results.slice(0, 25) });
});

// GET /foods/barcode/:code -> { result } | 404
foodsRouter.get("/barcode/:code", async (req, res) => {
  const code = String(req.params.code || "").replace(/\D/g, "");
  if (code.length < 6) return res.status(400).json({ error: "invalid barcode" });
  let result = null;
  try { result = await barcodeProvider(code); } catch (e) { console.error("[foods] OFF barcode failed:", e.message); }
  if (!result) {
    try { result = await barcodeUSDA(code); } catch (e) { console.error("[foods] USDA barcode failed:", e.message); }
  }
  if (!result) return res.status(404).json({ error: "no product found for that barcode" });
  res.json({ result });
});
