export type ManufacturerProductCandidate = {
  id: string;
  kind: "product" | "range";
  name: string;
  brand: string;
  sourceUrl: string;
  description: string;
  packageQuantity: string | null;
  sourceVerified: true;
};

export type ManufacturerSearchResult = {
  query: string;
  searchedAt: string;
  products: ManufacturerProductCandidate[];
  unavailableSources: { brand: string; message: string }[];
};

type ManufacturerSource = {
  brand: string;
  host: string;
  defaultQuery?: string;
  searchUrl?(query: string): string;
  sitemapUrl?: string;
  productPathPattern?: RegExp;
  parseResults?(body: string, query: string, host: string): { name: string; url: string }[];
};

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESULTS_PER_BRAND = 3;
const UNVERIFIED_BRANDS = [
  { brand: "Black Flower Research", message: "Aucune source officielle fiable n’a pu être confirmée; la recherche est désactivée pour éviter les résultats de revendeurs." },
  { brand: "Diablo Nutrients", message: "Aucun domaine officiel de fabricant n’a pu être confirmé; la recherche est désactivée." },
  { brand: "General Hydroponics", message: "Le domaine trouvé redirige vers un détaillant; une source fabricant officielle reste à confirmer." },
];

function cleanText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        && (codePoint < 0xd800 || codePoint > 0xdfff)
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&reg;/gi, "®")
    .replace(/&trade;/gi, "™")
    .replace(/Â(?=[®™©])/g, "")
    .replace(/â¢/g, "™")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function officialUrl(value: string, expectedHost: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === expectedHost || url.hostname.endsWith(`.${expectedHost}`))) {
    throw new Error("Résultat écarté : la page n’appartient pas au domaine officiel attendu.");
  }
  return url.href;
}

function queryTokens(query: string) {
  return query.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function wordpressResults(body: string, query: string, _host: string) {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error("La recherche officielle a renvoyé un format inattendu.");
  const tokens = queryTokens(query);
  return parsed.flatMap((value) => {
    if (!isRecord(value) || typeof value.title !== "string" || typeof value.url !== "string"
      || (value.subtype !== "page" && value.subtype !== "product")) return [];
    const name = cleanText(value.title);
    const nameTokens = queryTokens(name);
    const allTokensMatch = tokens.every((token) => nameTokens.some((nameToken) => nameToken === token || nameToken.startsWith(token)));
    if (!allTokensMatch || /\b(faq|related products|troubleshooting)\b/i.test(name)) return [];
    return [{ name, url: value.url }];
  });
}

function htmlSearchResults(body: string, query: string, host: string) {
  const tokens = queryTokens(query);
  const found: { name: string; url: string }[] = [];
  const anchors = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of body.matchAll(anchors)) {
    const label = cleanText(match[3] ?? "");
    const labelTokens = queryTokens(label);
    const allTokensMatch = tokens.every((token) => labelTokens.some((labelToken) => labelToken === token || labelToken.startsWith(token)));
    if (!label || !allTokensMatch) continue;
    try {
      const parsedUrl = new URL(match[2], `https://${host}`);
      if (/^\/(articles|news|cannatalk|about|growguide|search)(\/|$)/i.test(parsedUrl.pathname)) continue;
      const url = officialUrl(parsedUrl.href, host);
      if (!found.some((item) => item.url === url)) found.push({ name: label, url });
    } catch {
      continue;
    }
  }
  return found;
}

function bioBizzCatalogResults(body: string, query: string, host: string) {
  return htmlSearchResults(body, query, host).filter((result) => {
    const segments = new URL(result.url).pathname.split("/").filter(Boolean);
    return segments.length === 2 && segments[0] === "products";
  });
}

function sitemapLocations(body: string, host: string) {
  return [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].flatMap((match) => {
    try {
      const url = officialUrl(match[1].replaceAll("&amp;", "&"), host);
      return [url];
    } catch {
      return [];
    }
  });
}

async function sitemapResults(source: ManufacturerSource, query: string) {
  if (!source.sitemapUrl) return [];
  const sitemap = await fetchText(source.sitemapUrl);
  let locations = sitemapLocations(sitemap, source.host);
  if (/<sitemapindex\b/i.test(sitemap)) {
    const productSitemaps = locations.filter((url) => /product|store-products/i.test(new URL(url).pathname));
    const nested = await Promise.all(productSitemaps.slice(0, 5).map(async (url) => sitemapLocations(await fetchText(url), source.host)));
    locations = nested.flat();
  }

  const tokens = queryTokens(query);
  const excludedPath = /\/(blog|news|article|category|tag|author|about|contact|faq|privacy|terms|shipping|returns|careers)(\/|$)/i;
  const excludedSlug = /^(?:(?:our )?products?|shop|cookie policy|privacy policy|terms|contact|about|faq|sitemap|home)$/i;
  const matches = locations.flatMap((url) => {
    const pathname = new URL(url).pathname;
    if (excludedPath.test(pathname) || /sitemap|feed|\.xml$/i.test(pathname)) return [];
    const productPath = source.productPathPattern ?? /\/(products?|product-page)\//i;
    if (!productPath.test(pathname)) return [];
    const segments = pathname.split("/").filter(Boolean);
    if (!source.productPathPattern && segments.length < 2) return [];
    const searchable = queryTokens(pathname.replace(/[-_/]+/g, " "));
    const allTokensMatch = tokens.every((token) => searchable.some((part) => part === token || part.startsWith(token)));
    if (tokens.length && !allTokensMatch) return [];
    const slug = segments.pop() ?? "";
    let decodedSlug = slug;
    try {
      decodedSlug = decodeURIComponent(slug);
    } catch {
      return [];
    }
    const name = cleanText(decodedSlug.replace(/[-_]+/g, " ").replace(/\.(html?|php)$/i, ""));
    return name && !excludedSlug.test(name) ? [{ name, url }] : [];
  });
  return matches;
}

const SOURCES: ManufacturerSource[] = [
  {
    brand: "BioBizz",
    host: "biobizz.com",
    searchUrl: () => "https://biobizz.com/products",
    parseResults: bioBizzCatalogResults,
  },
  {
    brand: "Advanced Nutrients",
    host: "advancednutrients.com",
    searchUrl: (query) => `https://www.advancednutrients.com/wp-json/wp/v2/search?${new URLSearchParams({ search: query, per_page: "40" })}`,
    parseResults: wordpressResults,
  },
  {
    brand: "CANNA",
    host: "www.cannagardening.com",
    searchUrl: (query) => `https://www.cannagardening.com/search?${new URLSearchParams({ search: query })}`,
    parseResults: htmlSearchResults,
  },
  {
    brand: "Botanicare",
    host: "www.botanicare.com",
    sitemapUrl: "https://www.botanicare.com/sitemap_index.xml",
    parseResults: () => [],
  },
  {
    brand: "Cyco",
    host: "cycoflower.com",
    sitemapUrl: "https://cycoflower.com/sitemap_index.xml",
    productPathPattern: /^\/[a-z0-9]+(?:-[a-z0-9]+)+\/?$/i,
    parseResults: () => [],
  },
  {
    brand: "FoxFarm",
    host: "foxfarm.com",
    sitemapUrl: "https://foxfarm.com/product-sitemap.xml",
    parseResults: () => [],
  },
  {
    brand: "Gaia Green",
    host: "www.gaiagreen.com",
    sitemapUrl: "https://www.gaiagreen.com/store-products-sitemap.xml",
    parseResults: () => [],
  },
  {
    brand: "Green Planet",
    host: "greenplanetnutrients.com",
    sitemapUrl: "https://greenplanetnutrients.com/product-sitemap.xml",
    parseResults: () => [],
  },
  {
    brand: "Grotek",
    host: "www.grotek.com",
    sitemapUrl: "https://www.grotek.com/sitemap_index.xml",
    parseResults: () => [],
  },
  {
    brand: "House & Garden",
    host: "house-garden.us",
    sitemapUrl: "https://house-garden.us/products-sitemap.xml",
    parseResults: () => [],
  },
  {
    brand: "NPK Industries · RAW",
    host: "npk-industries.com",
    defaultQuery: "RAW",
    searchUrl: (query) => `https://npk-industries.com/search?${new URLSearchParams({ q: query, type: "product" })}`,
    parseResults: htmlSearchResults,
  },
  {
    brand: "Optic Foliar",
    host: "opticfoliar.ca",
    sitemapUrl: "https://opticfoliar.ca/page-sitemap.xml",
    productPathPattern: /\/products?\//i,
    parseResults: () => [],
  },
];

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/json, text/html;q=0.9" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Le fabricant a répondu avec le statut HTTP ${response.status}.`);
  return response.text();
}

function metaContent(html: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escapedKey}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${escapedKey}["'][^>]*>`, "i"),
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean);
}

function productJsonLd(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = productJsonLd(item);
      if (result) return result;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const type = value["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return value;
  for (const nested of Object.values(value)) {
    const result = productJsonLd(nested);
    if (result) return result;
  }
  return undefined;
}

function packageQuantity(html: string): string | null {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const product = productJsonLd(JSON.parse(match[1]));
      const weight = product?.weight;
      if (isRecord(weight) && (typeof weight.value === "number" || typeof weight.value === "string")) {
        const unit = typeof weight.unitText === "string" ? weight.unitText : typeof weight.unitCode === "string" ? weight.unitCode : "";
        if (unit) return `${weight.value} ${unit}`;
      }
      const size = product?.size;
      if (typeof size === "string" && /\d/.test(size)) return cleanText(size);
    } catch {
      continue;
    }
  }
  return null;
}

async function scrapeCandidate(source: ManufacturerSource, result: { name: string; url: string }): Promise<ManufacturerProductCandidate> {
  const sourceUrl = officialUrl(result.url, source.host);
  const html = await fetchText(sourceUrl);
  const description = metaContent(html, "og:description") ?? metaContent(html, "description");
  const pageTitle = metaContent(html, "og:title")
    ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? result.name;
  const pathname = new URL(sourceUrl).pathname;
  return {
    id: `${source.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${encodeURIComponent(sourceUrl)}`,
    kind: /\/products?\//i.test(pathname) ? "product" : "range",
    name: cleanText(pageTitle).replace(/\s+[|–—-]\s+[^|–—-]+$/, "") || cleanText(result.name),
    brand: source.brand,
    sourceUrl,
    description: cleanText(description ?? ""),
    packageQuantity: packageQuantity(html),
    sourceVerified: true,
  };
}

async function searchSource(source: ManufacturerSource, query: string) {
  const brandTokens = new Set(queryTokens(source.brand));
  const queryParts = queryTokens(query);
  const includesFullBrand = [...brandTokens].every((token) => queryParts.includes(token));
  const tokens = includesFullBrand ? queryParts.filter((token) => !brandTokens.has(token)) : queryParts;
  const searchQuery = tokens.join(" ");
  const entries = source.searchUrl
      ? source.parseResults?.(await fetchText(source.searchUrl(searchQuery || source.defaultQuery || query)), searchQuery || source.defaultQuery || query, source.host) ?? []
      : source.sitemapUrl
        ? await sitemapResults(source, searchQuery)
      : [];
  return entries.slice(0, MAX_RESULTS_PER_BRAND);
}

export async function searchOfficialManufacturerProducts(queryValue: string): Promise<ManufacturerSearchResult> {
  const query = queryValue.trim();
  if (query.length < 2 || query.length > 80) {
    throw new Error("La recherche doit contenir entre 2 et 80 caractères.");
  }

  const results = await Promise.all(SOURCES.map(async (source) => {
    try {
      const entries = await searchSource(source, query);
      const candidateResults = await Promise.allSettled(entries.map((entry) => scrapeCandidate(source, entry)));
      const candidates = candidateResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const failures = candidateResults.flatMap((result) => result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : "Une fiche officielle n’a pas pu être chargée."]
        : []);
      return {
        brand: source.brand,
        candidates,
        error: failures.length ? [...new Set(failures)].join(" ") : null,
      };
    } catch (error) {
      return {
        brand: source.brand,
        candidates: [],
        error: error instanceof Error ? error.message : "La source du fabricant est indisponible.",
      };
    }
  }));

  return {
    query,
    searchedAt: new Date().toISOString(),
    products: results.flatMap((result) => result.candidates),
    unavailableSources: [
      ...results.flatMap((result) => result.error ? [{ brand: result.brand, message: result.error }] : []),
      ...UNVERIFIED_BRANDS,
    ],
  };
}
