// price-service.js
//
// Live USD price service with caching and fallbacks.
// Production note:
// Free endpoints can rate-limit. For large-scale production, replace/add:
// - CoinGecko Pro
// - Binance API key
// - Polygon.io
// - Finnhub
// - Twelve Data
//

const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const FETCH_TIMEOUT_MS = 10000;

const priceCache = new Map();

const STABLECOINS = new Set([
    'USDC',
    'USDT',
    'DAI',
    'USDS',
    'FDUSD',
    'TUSD',
    'BUSD',
    'USDE'
]);

const COINGECKO_IDS = {
    ETH: 'ethereum',
    BNB: 'binancecoin',
    MATIC: 'matic-network',
    POL: 'polygon-ecosystem-token',
    SOL: 'solana',
    USDC: 'usd-coin',
    USDT: 'tether',
    DAI: 'dai',
    WBTC: 'wrapped-bitcoin',
    BTC: 'bitcoin',
    XRP: 'ripple',
    ADA: 'cardano',
    DOGE: 'dogecoin',
    AVAX: 'avalanche-2',
    LINK: 'chainlink',
    SHIB: 'shiba-inu',
    PEPE: 'pepe',
    WIF: 'dogwifcoin',
    BONK: 'bonk'
};

function normalizeSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase();
}

function roundPrice(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num;
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'FlashMarkets-Bot/1.0'
            },
            signal: controller.signal
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
        }

        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

function getCachedPrice(symbol) {
    const key = normalizeSymbol(symbol);
    const item = priceCache.get(key);

    if (!item) return null;

    if (Date.now() > item.expires) {
        priceCache.delete(key);
        return null;
    }

    return item.price;
}

function setCachedPrice(symbol, price) {
    const key = normalizeSymbol(symbol);
    if (!key || !Number.isFinite(price) || price <= 0) return;

    priceCache.set(key, {
        price,
        expires: Date.now() + CACHE_TTL_MS
    });
}

async function fetchCoinGeckoPrices(symbols) {
    const missing = symbols
        .map(normalizeSymbol)
        .filter(symbol => symbol && !STABLECOINS.has(symbol) && COINGECKO_IDS[symbol]);

    if (missing.length === 0) return {};

    const ids = [...new Set(missing.map(symbol => COINGECKO_IDS[symbol]))];
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd`;

    const data = await fetchJson(url);
    const result = {};

    for (const symbol of missing) {
        const id = COINGECKO_IDS[symbol];
        const price = roundPrice(data?.[id]?.usd);
        if (price) result[symbol] = price;
    }

    return result;
}

async function fetchBinancePrice(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || STABLECOINS.has(normalized)) return null;

    // Most Binance pairs are SYMBOLUSDT.
    const pair = `${normalized}USDT`;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`;

    try {
        const data = await fetchJson(url);
        return roundPrice(data?.price);
    } catch (err) {
        return null;
    }
}

async function fetchPricesForSymbols(symbols) {
    const unique = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];

    const prices = {};
    const errors = [];

    const missing = [];

    for (const symbol of unique) {
        if (STABLECOINS.has(symbol)) {
            prices[symbol] = 1;
            continue;
        }

        const cached = getCachedPrice(symbol);
        if (cached) {
            prices[symbol] = cached;
            continue;
        }

        missing.push(symbol);
    }

    if (missing.length > 0) {
        // Try CoinGecko batch first.
        try {
            const coingeckoPrices = await fetchCoinGeckoPrices(missing);

            for (const [symbol, price] of Object.entries(coingeckoPrices)) {
                prices[symbol] = price;
                setCachedPrice(symbol, price);
            }
        } catch (err) {
            errors.push(`CoinGecko failed: ${err.message}`);
        }

        // Try Binance individually for anything still missing.
        const stillMissing = missing.filter(symbol => !prices[symbol]);

        const binanceResults = await Promise.allSettled(
            stillMissing.map(async symbol => {
                const price = await fetchBinancePrice(symbol);
                return { symbol, price };
            })
        );

        for (const item of binanceResults) {
            if (item.status !== 'fulfilled') continue;

            const { symbol, price } = item.value;
            if (price) {
                prices[symbol] = price;
                setCachedPrice(symbol, price);
            }
        }

        const unresolved = stillMissing.filter(symbol => !prices[symbol]);
        if (unresolved.length > 0) {
            errors.push(`No USD price found for: ${unresolved.join(', ')}`);
        }
    }

    return { prices, errors };
}

module.exports = {
    fetchPricesForSymbols
};