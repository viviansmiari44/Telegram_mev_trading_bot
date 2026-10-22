// market-data.js
//
// Real market candle provider.
// Uses Binance for crypto and Yahoo Finance for forex/stocks.
// If live data fails, returns null. No synthetic fallback.
//

const CACHE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

const candleCache = new Map();

const ASSET_UNIVERSES = {
    forex: {
        gold: [
            { symbol: 'GC=F', name: 'Gold / XAUUSD', type: 'yahoo' },
            { symbol: 'XAUUSD=X', name: 'Gold Spot', type: 'yahoo' }
        ],
        majors: [
            { symbol: 'EURUSD=X', name: 'EUR/USD', type: 'yahoo' },
            { symbol: 'GBPUSD=X', name: 'GBP/USD', type: 'yahoo' },
            { symbol: 'USDJPY=X', name: 'USD/JPY', type: 'yahoo' },
            { symbol: 'AUDUSD=X', name: 'AUD/USD', type: 'yahoo' },
            { symbol: 'USDCAD=X', name: 'USD/CAD', type: 'yahoo' }
        ],
        indices: [
            { symbol: '^GSPC', name: 'S&P 500', type: 'yahoo' },
            { symbol: '^NDX', name: 'NASDAQ 100', type: 'yahoo' },
            { symbol: '^DJI', name: 'Dow Jones', type: 'yahoo' },
            { symbol: '^FTSE', name: 'FTSE 100', type: 'yahoo' },
            { symbol: '^STOXX50E', name: 'EURO STOXX 50', type: 'yahoo' }
        ],
        crypto_fx: [
            { symbol: 'BTC-USD', name: 'BTC/USD', type: 'yahoo' },
            { symbol: 'ETH-USD', name: 'ETH/USD', type: 'yahoo' },
            { symbol: 'SOL-USD', name: 'SOL/USD', type: 'yahoo' }
        ],
        all: []
    },
    crypto: {
        btc_eth: [
            { symbol: 'BTCUSDT', name: 'BTC/USDT', type: 'binance' },
            { symbol: 'ETHUSDT', name: 'ETH/USDT', type: 'binance' }
        ],
        top20: [
            { symbol: 'BTCUSDT', name: 'BTC/USDT', type: 'binance' },
            { symbol: 'ETHUSDT', name: 'ETH/USDT', type: 'binance' },
            { symbol: 'SOLUSDT', name: 'SOL/USDT', type: 'binance' },
            { symbol: 'BNBUSDT', name: 'BNB/USDT', type: 'binance' },
            { symbol: 'XRPUSDT', name: 'XRP/USDT', type: 'binance' },
            { symbol: 'ADAUSDT', name: 'ADA/USDT', type: 'binance' },
            { symbol: 'AVAXUSDT', name: 'AVAX/USDT', type: 'binance' },
            { symbol: 'LINKUSDT', name: 'LINK/USDT', type: 'binance' },
            { symbol: 'DOGEUSDT', name: 'DOGE/USDT', type: 'binance' },
            { symbol: 'MATICUSDT', name: 'MATIC/USDT', type: 'binance' }
        ],
        memecoins: [
            { symbol: 'DOGEUSDT', name: 'DOGE/USDT', type: 'binance' },
            { symbol: 'SHIBUSDT', name: 'SHIB/USDT', type: 'binance' },
            { symbol: 'PEPEUSDT', name: 'PEPE/USDT', type: 'binance' },
            { symbol: 'WIFUSDT', name: 'WIF/USDT', type: 'binance' },
            { symbol: 'BONKUSDT', name: 'BONK/USDT', type: 'binance' }
        ],
        all_liquid: []
    },
    stock: {
        us: [
            { symbol: 'AAPL', name: 'Apple', type: 'yahoo' },
            { symbol: 'NVDA', name: 'NVIDIA', type: 'yahoo' },
            { symbol: 'TSLA', name: 'Tesla', type: 'yahoo' },
            { symbol: 'MSFT', name: 'Microsoft', type: 'yahoo' },
            { symbol: 'AMZN', name: 'Amazon', type: 'yahoo' },
            { symbol: 'META', name: 'Meta', type: 'yahoo' }
        ],
        uk: [
            { symbol: '^FTSE', name: 'FTSE 100', type: 'yahoo' },
            { symbol: 'SHEL.L', name: 'Shell', type: 'yahoo' },
            { symbol: 'AZN.L', name: 'AstraZeneca', type: 'yahoo' },
            { symbol: 'HSBA.L', name: 'HSBC', type: 'yahoo' }
        ],
        eu: [
            { symbol: '^STOXX50E', name: 'EURO STOXX 50', type: 'yahoo' },
            { symbol: 'SAP.DE', name: 'SAP', type: 'yahoo' },
            { symbol: 'ASML.AS', name: 'ASML', type: 'yahoo' },
            { symbol: 'MC.PA', name: 'LVMH', type: 'yahoo' }
        ],
        asia: [
            { symbol: '^N225', name: 'Nikkei 225', type: 'yahoo' },
            { symbol: '005930.KS', name: 'Samsung', type: 'yahoo' },
            { symbol: '9988.T', name: 'Alibaba HK', type: 'yahoo' },
            { symbol: 'TCEHY', name: 'Tencent ADR', type: 'yahoo' }
        ]
    },
    mev: {
        all: [
            { symbol: 'ETHUSDT', name: 'ETH/USDT', type: 'binance' },
            { symbol: 'SOLUSDT', name: 'SOL/USDT', type: 'binance' },
            { symbol: 'BNBUSDT', name: 'BNB/USDT', type: 'binance' }
        ]
    }
};

// Build combined lists.
ASSET_UNIVERSES.forex.all = [
    ...ASSET_UNIVERSES.forex.gold,
    ...ASSET_UNIVERSES.forex.majors,
    ...ASSET_UNIVERSES.forex.indices,
    ...ASSET_UNIVERSES.forex.crypto_fx
];

ASSET_UNIVERSES.crypto.all_liquid = [
    ...ASSET_UNIVERSES.crypto.top20,
    ...ASSET_UNIVERSES.crypto.memecoins
];

function shuffle(array) {
    const arr = [...array];

    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    return arr;
}

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeInterval(interval) {
    const allowed = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
    return allowed.has(interval) ? interval : '5m';
}

function getIntervalForMarket(market, settings = {}) {
    if (market === 'crypto') {
        return normalizeInterval(settings.timeframe || '5m');
    }

    if (market === 'forex') {
        if (settings.strategy === 'scalping') return '1m';
        if (settings.strategy === 'swing') return '1h';
        return '5m';
    }

    if (market === 'stock') {
        if (settings.holding === 'intraday') return '5m';
        if (settings.holding === 'swing') return '1h';
        if (settings.holding === 'long_term') return '1d';
        return '15m';
    }

    if (market === 'mev') {
        return '1m';
    }

    return '5m';
}

function getYahooRange(interval) {
    switch (interval) {
        case '1m':
            return '1d';
        case '5m':
            return '2d';
        case '15m':
            return '5d';
        case '1h':
            return '7d';
        case '4h':
            return '1mo';
        case '1d':
            return '3mo';
        default:
            return '2d';
    }
}

function getCachedCandles(key) {
    const item = candleCache.get(key);
    if (!item) return null;

    if (Date.now() > item.expires) {
        candleCache.delete(key);
        return null;
    }

    return item.candles;
}

function setCachedCandles(key, candles) {
    candleCache.set(key, {
        candles,
        expires: Date.now() + CACHE_TTL_MS
    });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchBinanceCandles(symbol, interval = '5m', limit = 120) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

    const data = await res.json();

    if (!Array.isArray(data)) return [];

    return data
        .map(c => ({
            time: Number(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
        }))
        .filter(c =>
            Number.isFinite(c.time) &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close)
        );
}

async function fetchYahooCandles(symbol, interval = '5m', limit = 120) {
    const range = getYahooRange(interval);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;

    const res = await fetchWithTimeout(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    });

    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

    const data = await res.json();
    const result = data?.chart?.result?.[0];

    if (!result) return [];

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    const candles = timestamps
        .map((t, i) => ({
            time: Number(t) * 1000,
            open: parseFloat(quote.open?.[i]),
            high: parseFloat(quote.high?.[i]),
            low: parseFloat(quote.low?.[i]),
            close: parseFloat(quote.close?.[i]),
            volume: parseFloat(quote.volume?.[i] || 0)
        }))
        .filter(c =>
            Number.isFinite(c.time) &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close)
        );

    return candles.slice(-limit);
}

function getAssetList(market, settings = {}) {
    const universe = ASSET_UNIVERSES[market];

    if (!universe) {
        return ASSET_UNIVERSES.crypto.top20;
    }

    if (market === 'forex') {
        const pairFocus = settings.pairs || 'all';
        return universe[pairFocus] || universe.all;
    }

    if (market === 'crypto') {
        const pairFocus = settings.pairs || 'top20';
        return universe[pairFocus] || universe.all_liquid;
    }

    if (market === 'stock') {
        const region = settings.stock_market || 'us';
        return universe[region] || universe.us;
    }

    if (market === 'mev') {
        return universe.all;
    }

    return ASSET_UNIVERSES.crypto.top20;
}

// Kept for backward compatibility.
function selectAsset(market, settings = {}) {
    const list = getAssetList(market, settings);

    if (!Array.isArray(list) || list.length === 0) {
        return null;
    }

    return randomItem(list);
}

function selectAssets(market, settings = {}, count = 3) {
    const list = getAssetList(market, settings);

    if (!Array.isArray(list) || list.length === 0) {
        return [];
    }

    const unique = [];
    const seen = new Set();

    for (const asset of list) {
        const key = `${asset.type}:${asset.symbol}`;

        if (!seen.has(key)) {
            seen.add(key);
            unique.push(asset);
        }
    }

    return shuffle(unique).slice(0, count);
}

async function fetchCandlesForAsset(asset, interval) {
    if (asset.type === 'binance') {
        return await fetchBinanceCandles(asset.symbol, interval, 150);
    }

    return await fetchYahooCandles(asset.symbol, interval, 150);
}

async function getCandles(market, settings = {}) {
    const interval = getIntervalForMarket(market, settings);
    const assets = selectAssets(market, settings, 3);

    if (!assets || assets.length === 0) {
        console.warn(`⚠️ No asset universe found for market ${market}`);
        return null;
    }

    const errors = [];

    for (const asset of assets) {
        const key = `${market}:${asset.symbol}:${interval}`;

        const cached = getCachedCandles(key);

        if (cached && cached.length >= 40) {
            console.log(`[MARKET_DATA] Cache hit: ${asset.symbol} interval=${interval} candles=${cached.length}`);
            return {
                asset,
                candles: cached,
                interval
            };
        }

        try {
            console.log(`[MARKET_DATA] Fetching ${asset.symbol} (${asset.type}) interval=${interval}`);

            const candles = await fetchCandlesForAsset(asset, interval);

            if (!candles || candles.length < 40) {
                errors.push(`${asset.symbol}: only ${candles?.length || 0} candles`);
                console.warn(`⚠️ Not enough real candles for ${asset.symbol}. Trying next asset.`);
                continue;
            }

            setCachedCandles(key, candles);

            console.log(`[MARKET_DATA] Using ${asset.symbol}, candles=${candles.length}`);

            return {
                asset,
                candles,
                interval
            };
        } catch (err) {
            errors.push(`${asset.symbol}: ${err.message}`);
            console.error(`❌ Market data failed for ${asset.symbol}:`, err.message);
        }
    }

    console.warn(`⚠️ Market data unavailable for ${market}. Tried: ${errors.join(' | ')}`);
    return null;
}

module.exports = {
    getCandles,
    selectAsset,
    selectAssets,
    getAssetList
};