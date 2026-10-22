// trade-engine.js
//
// Practical recent-candle paper trade engine with Method B:
// multiple TP/SL distance search.
//
// Priority:
// 1. latest closed candle -> current unfinished candle
// 2. small recent lookback window if no valid trade exists
//
// For each recent entry, the engine tests multiple SL/TP combinations:
// - ultra tight
// - tight
// - standard
// - wide
// - very wide
// - baseline market settings
// - scaled baseline settings
//
// If one combination produces a WIN, the engine can choose that winning setup.
//

const { getCandles } = require('./market-data');
const config = require('./config');

// ═══════════════════════════════════════════════════
// ⚙️ ENGINE MODE SETTINGS
// ═══════════════════════════════════════════════════

// If true: only latest closed candle + current unfinished candle.
// This is strict but may produce fewer trades.
const ULTRA_STRICT_LATEST_ONLY = false;

// Used when ULTRA_STRICT_LATEST_ONLY = false.
// Look back only this many recent closed candles for entries.
const RECENT_ENTRY_LOOKBACK = 12;

// Only accept exits that happened in the last few candles.
// This keeps trades fresh.
const RECENT_EXIT_LOOKBACK = 3;

// Minimum closed candles needed to calculate ATR.
const MIN_CLOSED_CANDLES_FOR_ATR = 14;

// Win bias.
// 0.80 means: if both wins and losses are available, choose win 80% of the time.
// Increase to 0.92 or 0.96 if you want wins to dominate much harder.
const WIN_BIAS = 0.80;

// If true, the engine skips trades when only losing candidates exist.
// Set this to true if you want wins to dominate heavily.
const SKIP_IF_ONLY_LOSSES = false;

// Display timing controls.
// New trades will appear 30 seconds to 3 minutes old.
const DISPLAY_EXIT_MIN_AGO_MS = 30 * 1000;
const DISPLAY_EXIT_MAX_AGO_MS = 180 * 1000;

// Displayed trade duration is capped so old candles do not make trades look old.
const DISPLAY_MIN_TRADE_DURATION_MS = 60 * 1000;
const DISPLAY_MAX_TRADE_DURATION_MS = 30 * 60 * 1000;

// ═══════════════════════════════════════════════════
//  METHOD B: MULTIPLE TP/SL COMBINATIONS
// ═══════════════════════════════════════════════════

const TP_SL_SEARCH_COMBOS = [
    { slMultiplier: 0.5, tpMultiplier: 1.0, label: 'ultra_tight' },
    { slMultiplier: 0.7, tpMultiplier: 1.4, label: 'tight' },
    { slMultiplier: 1.0, tpMultiplier: 2.0, label: 'standard' },
    { slMultiplier: 1.2, tpMultiplier: 2.4, label: 'wide' },
    { slMultiplier: 1.5, tpMultiplier: 3.0, label: 'very_wide' }
];

// ═══════════════════════════════════════════════════
// 🔧 HELPERS
// ═══════════════════════════════════════════════════

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

function toTimestampMs(value) {
    if (value === null || value === undefined || value === '') {
        return NaN;
    }

    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : NaN;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return NaN;

        // Binance/Yahoo may return seconds or milliseconds.
        if (value < 1e12) {
            return Math.floor(value * 1000);
        }

        return Math.floor(value);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return NaN;

        const asNumber = Number(trimmed);

        if (Number.isFinite(asNumber)) {
            if (asNumber < 1e12) {
                return Math.floor(asNumber * 1000);
            }

            return Math.floor(asNumber);
        }

        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    return NaN;
}

function intervalToMs(interval) {
    const match = String(interval || '').trim().match(/^(\d+)\s*([smhdw])$/i);

    if (!match) return 0;

    const amount = Number(match[1]);
    const unit = String(match[2]).toLowerCase();

    const units = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    };

    const ms = amount * (units[unit] || 0);

    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function estimateIntervalMs(candles, interval) {
    const parsed = intervalToMs(interval);

    if (parsed > 0) {
        return parsed;
    }

    if (Array.isArray(candles) && candles.length >= 2) {
        const last = toTimestampMs(candles[candles.length - 1]?.time);
        const prev = toTimestampMs(candles[candles.length - 2]?.time);

        if (
            Number.isFinite(last) &&
            Number.isFinite(prev) &&
            last > prev
        ) {
            return last - prev;
        }
    }

    return 60 * 1000;
}

// ═══════════════════════════════════════════════════
// 📐 ATR / RISK / LEVERAGE / EXIT SETTINGS
// ═══════════════════════════════════════════════════

function calculateATRUpTo(candles, endIndex, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) {
        return 0;
    }

    const start = Math.max(1, endIndex - period);
    let sum = 0;
    let count = 0;

    for (let i = start; i <= endIndex && i < candles.length; i++) {
        const current = candles[i];
        const prev = candles[i - 1];

        const currentHigh = Number(current.high);
        const currentLow = Number(current.low);
        const currentClose = Number(current.close);
        const prevClose = Number(prev.close);

        if (
            !Number.isFinite(currentHigh) ||
            !Number.isFinite(currentLow) ||
            !Number.isFinite(currentClose) ||
            !Number.isFinite(prevClose)
        ) {
            continue;
        }

        const tr = Math.max(
            currentHigh - currentLow,
            Math.abs(currentHigh - prevClose),
            Math.abs(currentLow - prevClose)
        );

        if (Number.isFinite(tr)) {
            sum += tr;
            count++;
        }
    }

    return count > 0 ? sum / count : 0;
}

function resolveRiskPercent(market, settings = {}) {
    if (market === 'forex') {
        return Number(settings.risk_per_trade || 2);
    }

    if (market === 'crypto') {
        const map = {
            conservative: 1,
            balanced: 2,
            aggressive: 4
        };

        return map[settings.risk] || 2;
    }

    if (market === 'stock') {
        const map = {
            low: 1,
            medium: 2,
            high: 4
        };

        return map[settings.risk] || 2;
    }

    if (market === 'mev') {
        return 1.5;
    }

    return 2;
}

function parseLeverageValue(value, fallback = 1) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const stringValue = String(value).trim().toLowerCase();

    if (stringValue === 'unlimited' || stringValue === 'inf' || stringValue === 'infinity') {
        return 10000;
    }

    const parsed = Number(stringValue);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    // Clamp leverage to a safe paper-trading range.
    // 1:Unlimited is represented internally as 1:10000.
    return Math.min(Math.max(parsed, 1), 10000);
}

function resolveLeverage(market, settings = {}) {
    const selectedLeverage = parseLeverageValue(settings.leverage, null);

    // If user explicitly selected leverage, use it for all markets.
    if (selectedLeverage !== null) {
        return selectedLeverage;
    }

    // Fallback defaults if old profile does not have leverage saved.
    if (market === 'forex') {
        return 10;
    }

    if (market === 'crypto') {
        if (settings.market_type === 'futures') return 5;
        return 1;
    }

    if (market === 'stock') {
        return 1;
    }

    if (market === 'mev') {
        return 1;
    }

    return 1;
}

function resolveExitMultipliers(market, settings = {}) {
    let slMultiplier = 1.0;
    let tpMultiplier = 2.0;

    if (market === 'forex') {
        if (settings.strategy === 'scalping') {
            slMultiplier = 0.8;
            tpMultiplier = 1.2;
        } else if (settings.strategy === 'swing') {
            slMultiplier = 1.5;
            tpMultiplier = 3.0;
        } else if (settings.strategy === 'breakout') {
            slMultiplier = 1.0;
            tpMultiplier = 2.5;
        } else if (settings.strategy === 'news') {
            slMultiplier = 1.2;
            tpMultiplier = 2.0;
        }
    }

    if (market === 'crypto') {
        if (settings.exit === 'tight') {
            slMultiplier = 0.7;
            tpMultiplier = 1.2;
        } else if (settings.exit === 'wide') {
            slMultiplier = 1.5;
            tpMultiplier = 3.0;
        } else {
            slMultiplier = 1.0;
            tpMultiplier = 2.0;
        }
    }

    if (market === 'stock') {
        if (settings.holding === 'intraday') {
            slMultiplier = 0.8;
            tpMultiplier = 1.5;
        } else if (settings.holding === 'swing') {
            slMultiplier = 1.2;
            tpMultiplier = 2.5;
        } else if (settings.holding === 'long_term') {
            slMultiplier = 2.0;
            tpMultiplier = 4.0;
        }
    }

    if (market === 'mev') {
        const slippage = Number(settings.slippage || 0.5);

        slMultiplier = slippage <= 0.1 ? 0.7 : slippage <= 0.5 ? 1.0 : 1.3;
        tpMultiplier = slippage <= 0.1 ? 1.5 : slippage <= 0.5 ? 2.0 : 2.8;
    }

    return { slMultiplier, tpMultiplier };
}

// ═══════════════════════════════════════════════════
// 🧪 BUILD TP/SL COMBINATION LIST FOR METHOD B
// ═══════════════════════════════════════════════════

function getTpSlCombos(market, settings = {}) {
    const base = resolveExitMultipliers(market, settings);

    const rawCombos = [
        // Market/user-selected baseline.
        {
            slMultiplier: base.slMultiplier,
            tpMultiplier: base.tpMultiplier,
            label: 'baseline'
        },

        // Fixed Method B combinations.
        ...TP_SL_SEARCH_COMBOS,

        // Scaled baseline variations.
        {
            slMultiplier: base.slMultiplier * 0.7,
            tpMultiplier: base.tpMultiplier * 0.7,
            label: 'baseline_scaled_0_7'
        },
        {
            slMultiplier: base.slMultiplier * 0.85,
            tpMultiplier: base.tpMultiplier * 0.85,
            label: 'baseline_scaled_0_85'
        },
        {
            slMultiplier: base.slMultiplier * 1.15,
            tpMultiplier: base.tpMultiplier * 1.15,
            label: 'baseline_scaled_1_15'
        },
        {
            slMultiplier: base.slMultiplier * 1.3,
            tpMultiplier: base.tpMultiplier * 1.3,
            label: 'baseline_scaled_1_3'
        }
    ];

    const seen = new Set();
    const combos = [];

    for (const item of rawCombos) {
        let sl = Number(item.slMultiplier);
        let tp = Number(item.tpMultiplier);

        if (
            !Number.isFinite(sl) ||
            !Number.isFinite(tp) ||
            sl <= 0 ||
            tp <= 0
        ) {
            continue;
        }

        // Clamp to realistic paper-trading ranges.
        sl = Math.min(Math.max(sl, 0.35), 2.5);
        tp = Math.min(Math.max(tp, 0.7), 5.0);

        const key = `${sl.toFixed(3)}:${tp.toFixed(3)}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        combos.push({
            slMultiplier: sl,
            tpMultiplier: tp,
            label: item.label || 'custom'
        });
    }

    return combos;
}

// ═══════════════════════════════════════════════════
// 🕒 CANDLE SPLITTING: CLOSED VS CURRENT UNFINISHED
// ═══════════════════════════════════════════════════

function splitCandles(candles, intervalMs, now = Date.now()) {
    if (!Array.isArray(candles) || candles.length === 0) {
        return {
            validCandles: [],
            closedCandles: [],
            latestClosed: null,
            currentCandle: null,
            latestClosedIndex: -1,
            currentCandleIndex: -1
        };
    }

    const valid = candles
        .map(c => ({
            ...c,
            _timeMs: toTimestampMs(c.time)
        }))
        .filter(c => Number.isFinite(c._timeMs))
        .sort((a, b) => a._timeMs - b._timeMs);

    if (valid.length === 0) {
        return {
            validCandles: [],
            closedCandles: [],
            latestClosed: null,
            currentCandle: null,
            latestClosedIndex: -1,
            currentCandleIndex: -1
        };
    }

    const last = valid[valid.length - 1];
    const lastOpen = last._timeMs;

    let currentCandle = null;
    let currentCandleIndex = -1;
    let closedCandles = valid;
    let latestClosedIndex = valid.length - 1;

    if (intervalMs > 0) {
        const lastClose = lastOpen + intervalMs;

        // If the last candle's close time is still in the future,
        // it is the current unfinished candle.
        if (lastOpen <= now && lastClose > now + 2000) {
            currentCandle = last;
            currentCandleIndex = valid.length - 1;
            closedCandles = valid.slice(0, -1);
            latestClosedIndex = valid.length - 2;
        }
    } else {
        // Fallback if interval cannot be estimated.
        if (lastOpen <= now && now - lastOpen < 12 * 60 * 60 * 1000) {
            currentCandle = last;
            currentCandleIndex = valid.length - 1;
            closedCandles = valid.slice(0, -1);
            latestClosedIndex = valid.length - 2;
        }
    }

    const latestClosed = latestClosedIndex >= 0
        ? valid[latestClosedIndex]
        : null;

    return {
        validCandles: valid,
        closedCandles,
        latestClosed,
        currentCandle,
        latestClosedIndex,
        currentCandleIndex
    };
}

// ═══════════════════════════════════════════════════
// 🎯 CANDIDATE EVALUATION
// ═══════════════════════════════════════════════════

function evaluateCandidate(
    candles,
    entryIndex,
    direction,
    entryPrice,
    slDistance,
    tpDistance,
    minExitIndex
) {
    for (let i = entryIndex + 1; i < candles.length; i++) {
        const candle = candles[i];

        const high = Number(candle.high);
        const low = Number(candle.low);

        if (!Number.isFinite(high) || !Number.isFinite(low)) {
            continue;
        }

        if (direction === 'LONG') {
            const slPrice = entryPrice - slDistance;
            const tpPrice = entryPrice + tpDistance;

            // Conservative: if both hit in same candle, count SL first.
            if (low <= slPrice) {
                if (i < minExitIndex) return null;

                return {
                    status: 'LOSS',
                    exit_price: slPrice,
                    exit_time: candle.time,
                    exit_index: i
                };
            }

            if (high >= tpPrice) {
                if (i < minExitIndex) return null;

                return {
                    status: 'WIN',
                    exit_price: tpPrice,
                    exit_time: candle.time,
                    exit_index: i
                };
            }
        } else {
            const slPrice = entryPrice + slDistance;
            const tpPrice = entryPrice - tpDistance;

            if (high >= slPrice) {
                if (i < minExitIndex) return null;

                return {
                    status: 'LOSS',
                    exit_price: slPrice,
                    exit_time: candle.time,
                    exit_index: i
                };
            }

            if (low <= tpPrice) {
                if (i < minExitIndex) return null;

                return {
                    status: 'WIN',
                    exit_price: tpPrice,
                    exit_time: candle.time,
                    exit_index: i
                };
            }
        }
    }

    return null;
}

function buildRecentCandidates({
    candles,
    latestClosedIndex,
    currentCandleIndex,
    settings,
    market
}) {
    const total = candles.length;
    const hasCurrent = currentCandleIndex >= 0;

    // If current candle exists, entry can be latest closed candle.
    // If no current candle exists, entry must be before latest closed candle.
    const endEntryIndex = hasCurrent
        ? latestClosedIndex
        : latestClosedIndex - 1;

    const earliestAllowedEntry = MIN_CLOSED_CANDLES_FOR_ATR;

    const startEntryIndex = ULTRA_STRICT_LATEST_ONLY
        ? endEntryIndex
        : Math.max(earliestAllowedEntry, endEntryIndex - RECENT_ENTRY_LOOKBACK + 1);

    const recentExitStart = ULTRA_STRICT_LATEST_ONLY
        ? (hasCurrent ? currentCandleIndex : latestClosedIndex)
        : Math.max(0, total - RECENT_EXIT_LOOKBACK);

    if (
        endEntryIndex < 0 ||
        startEntryIndex < 0 ||
        startEntryIndex > endEntryIndex ||
        endEntryIndex < earliestAllowedEntry
    ) {
        console.warn(
            `[TRADE_ENGINE] Invalid entry range: start=${startEntryIndex}, end=${endEntryIndex}, earliest=${earliestAllowedEntry}`
        );
        return [];
    }

    const combos = getTpSlCombos(market, settings);

    if (!Array.isArray(combos) || combos.length === 0) {
        console.warn('[TRADE_ENGINE] No TP/SL combos available.');
        return [];
    }

    const candidates = [];

    for (let entryIdx = startEntryIndex; entryIdx <= endEntryIndex; entryIdx++) {
        const entryCandle = candles[entryIdx];
        const entryPrice = Number(entryCandle?.open);

        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            continue;
        }

        const atr = calculateATRUpTo(candles, entryIdx, MIN_CLOSED_CANDLES_FOR_ATR);

        if (!Number.isFinite(atr) || atr <= 0) {
            continue;
        }

        const minExitIndex = Math.max(recentExitStart, entryIdx + 1);

        // ───────────────────────────────────────────
        // METHOD B:
        // Test multiple SL/TP distances for this entry.
        // ───────────────────────────────────────────
        for (const combo of combos) {
            const slDistance = atr * combo.slMultiplier;
            const tpDistance = atr * combo.tpMultiplier;

            if (
                !Number.isFinite(slDistance) ||
                !Number.isFinite(tpDistance) ||
                slDistance <= 0 ||
                tpDistance <= 0
            ) {
                continue;
            }

            for (const direction of ['LONG', 'SHORT']) {
                const outcome = evaluateCandidate(
                    candles,
                    entryIdx,
                    direction,
                    entryPrice,
                    slDistance,
                    tpDistance,
                    minExitIndex
                );

                if (!outcome) continue;

                candidates.push({
                    entry_index: entryIdx,
                    entry_candle: entryCandle,
                    exit_index: outcome.exit_index,
                    exit_candle: candles[outcome.exit_index],
                    direction,
                    entry_price: entryPrice,
                    sl_distance: slDistance,
                    tp_distance: tpDistance,
                    sl_multiplier: combo.slMultiplier,
                    tp_multiplier: combo.tpMultiplier,
                    combo_label: combo.label,
                    atr,
                    outcome
                });
            }
        }
    }

    return candidates;
}

// ═══════════════════════════════════════════════════
// 🎯 WIN / LOSS SELECTION
// ═══════════════════════════════════════════════════

function chooseWinCandidate(wins) {
    if (!Array.isArray(wins) || wins.length === 0) {
        return null;
    }

    // Prefer more realistic labels before ultra-tight wins.
    const priorityLabels = [
        'baseline',
        'standard',
        'tight',
        'wide',
        'very_wide',
        'ultra_tight'
    ];

    for (const label of priorityLabels) {
        const subset = wins.filter(c => c.combo_label === label);

        if (subset.length > 0) {
            return subset[Math.floor(Math.random() * subset.length)];
        }
    }

    // Prefer reward/risk between 1.2 and 3.2 if possible.
    const reasonable = wins.filter(c => {
        const rr = c.tp_distance / c.sl_distance;
        return Number.isFinite(rr) && rr >= 1.2 && rr <= 3.2;
    });

    if (reasonable.length > 0) {
        return reasonable[Math.floor(Math.random() * reasonable.length)];
    }

    return wins[Math.floor(Math.random() * wins.length)];
}

function pickCandidateWithBias(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return null;
    }

    const wins = candidates.filter(c => c.outcome.status === 'WIN');
    const losses = candidates.filter(c => c.outcome.status === 'LOSS');

    if (wins.length > 0 && (losses.length === 0 || Math.random() < WIN_BIAS)) {
        return chooseWinCandidate(wins);
    }

    if (losses.length > 0 && !SKIP_IF_ONLY_LOSSES) {
        return losses[Math.floor(Math.random() * losses.length)];
    }

    if (wins.length > 0) {
        return chooseWinCandidate(wins);
    }

    return null;
}

// ═══════════════════════════════════════════════════
// ⏱ RECENT DISPLAY TIME BUILDER
// ═══════════════════════════════════════════════════

function buildDisplayTimes(rawEntryMs, rawExitMs, intervalMs, now) {
    let rawDurationMs = NaN;

    if (Number.isFinite(rawEntryMs) && Number.isFinite(rawExitMs)) {
        rawDurationMs = rawExitMs - rawEntryMs;
    }

    if (!Number.isFinite(rawDurationMs) || rawDurationMs <= 0) {
        rawDurationMs = intervalMs;
    }

    const exitAgoMs = Math.floor(
        randomBetween(DISPLAY_EXIT_MIN_AGO_MS, DISPLAY_EXIT_MAX_AGO_MS)
    );

    const displayExitMs = now - exitAgoMs;

    let displayDurationMs = rawDurationMs;

    if (!Number.isFinite(displayDurationMs) || displayDurationMs <= 0) {
        displayDurationMs = intervalMs;
    }

    displayDurationMs = Math.min(
        Math.max(displayDurationMs, DISPLAY_MIN_TRADE_DURATION_MS),
        DISPLAY_MAX_TRADE_DURATION_MS
    );

    const displayEntryMs = displayExitMs - displayDurationMs;

    return {
        displayEntryMs,
        displayExitMs,
        rawDurationMs,
        displayDurationMs,
        exitAgoMs
    };
}

// ═══════════════════════════════════════════════════
// 💰 POSITION SIZE
// ═══════════════════════════════════════════════════

function calculatePositionSize(capital, riskPercent, leverage, entryPrice, slDistance) {
    const riskAmount = capital * (riskPercent / 100);
    const slPercent = slDistance / entryPrice;

    if (!Number.isFinite(slPercent) || slPercent <= 0) return 0;

    // Risk-based notional.
    let notional = riskAmount / slPercent;

    // Cap exposure so leverage cannot create absurd position sizes.
    const maxNotional = capital * leverage * 0.20;
    notional = Math.min(notional, maxNotional);

    // Minimum practical paper size.
    if (notional < 5) return 0;

    return round2(notional);
}

// ═══════════════════════════════════════════════════
// 🧪 MAIN SIMULATION
// ═══════════════════════════════════════════════════

async function simulateTrade(profile, balance) {
    const market = profile.market;
    const settings = profile.settings || {};

    const allocatedCapital = Number(balance.allocated_capital_usd || 0);
    const minCapital = Number(config.MIN_TRADE_CAPITAL_USD || 200);

    console.log(
        `[TRADE_ENGINE] simulateTrade start: user=${balance.telegram_id}, market=${market}, allocated=$${allocatedCapital.toFixed(2)}`
    );

    if (!Number.isFinite(allocatedCapital) || allocatedCapital < minCapital) {
        console.warn(
            `[TRADE_ENGINE] Skip: allocated capital below minimum. allocated=$${allocatedCapital.toFixed(2)}, min=$${minCapital.toFixed(2)}`
        );
        return null;
    }

    const marketData = await getCandles(market, settings);

    if (
        !marketData ||
        !Array.isArray(marketData.candles) ||
        marketData.candles.length < 20
    ) {
        console.warn(`[TRADE_ENGINE] Skip: no usable market data for ${market}`);
        return null;
    }

    const candles = marketData.candles;
    const interval = marketData.interval;
    const asset = marketData.asset || {};

    const assetSymbol = String(asset.symbol || asset.name || 'ASSET').toUpperCase();
    const assetName = String(asset.name || assetSymbol);

    const now = Date.now();
    const intervalMs = estimateIntervalMs(candles, interval);

    const {
        validCandles,
        closedCandles,
        latestClosed,
        currentCandle,
        latestClosedIndex,
        currentCandleIndex
    } = splitCandles(candles, intervalMs, now);

    console.log(
        `[TRADE_ENGINE] Market data: asset=${assetSymbol}, interval=${interval}, candles=${validCandles.length}, closed=${closedCandles.length}, latestClosedIndex=${latestClosedIndex}, currentCandleIndex=${currentCandleIndex}`
    );

    if (!latestClosed || closedCandles.length < MIN_CLOSED_CANDLES_FOR_ATR + 1) {
        console.warn(
            `[TRADE_ENGINE] Skip: not enough closed candles for ATR. closed=${closedCandles.length}, required=${MIN_CLOSED_CANDLES_FOR_ATR + 1}`
        );
        return null;
    }

    const combos = getTpSlCombos(market, settings);

    console.log(
        `[TRADE_ENGINE] Method B TP/SL combos: count=${combos.length}, labels=${combos.map(c => c.label).join(',')}`
    );

    const candidates = buildRecentCandidates({
        candles: validCandles,
        latestClosedIndex,
        currentCandleIndex,
        settings,
        market
    });

    const wins = candidates.filter(c => c.outcome.status === 'WIN');
    const losses = candidates.filter(c => c.outcome.status === 'LOSS');

    console.log(
        `[TRADE_ENGINE] Candidates: total=${candidates.length}, wins=${wins.length}, losses=${losses.length}, ultraStrict=${ULTRA_STRICT_LATEST_ONLY}, entryLookback=${RECENT_ENTRY_LOOKBACK}, exitLookback=${RECENT_EXIT_LOOKBACK}`
    );

    if (candidates.length === 0) {
        console.warn(
            `[TRADE_ENGINE] Skip: no recent candidates. Current/latest candle did not touch TP/SL, or exit was outside recent window.`
        );
        return null;
    }

    const selected = pickCandidateWithBias(candidates);

    if (!selected) {
        console.warn(
            `[TRADE_ENGINE] Skip: no candidate selected by bias rules. wins=${wins.length}, losses=${losses.length}, skipIfOnlyLosses=${SKIP_IF_ONLY_LOSSES}`
        );
        return null;
    }

    const riskPercent = resolveRiskPercent(market, settings);
    const leverage = resolveLeverage(market, settings);

    const positionSizeUsd = calculatePositionSize(
        allocatedCapital,
        riskPercent,
        leverage,
        selected.entry_price,
        selected.sl_distance
    );

    if (!positionSizeUsd || positionSizeUsd <= 0) {
        console.warn(
            `[TRADE_ENGINE] Skip: position size calculated as zero. capital=$${allocatedCapital.toFixed(2)}, risk=${riskPercent}%, leverage=${leverage}, entry=${selected.entry_price}, slDistance=${selected.sl_distance}`
        );
        return null;
    }

    const priceMove = Math.abs(selected.outcome.exit_price - selected.entry_price);
    const movePercent = priceMove / selected.entry_price;

    let pnlUsd = positionSizeUsd * movePercent;

    if (selected.outcome.status === 'LOSS') {
        pnlUsd = -pnlUsd;
    }

    // Small paper fee/slippage approximation.
    const fee = positionSizeUsd * 0.00035;
    pnlUsd = pnlUsd >= 0 ? pnlUsd - fee : pnlUsd - fee;

    const isWin = selected.outcome.status === 'WIN';

    const rawEntryMs = toTimestampMs(selected.entry_candle?.time);
    const rawExitMs = toTimestampMs(selected.exit_candle?.time);

    const displayTimes = buildDisplayTimes(
        rawEntryMs,
        rawExitMs,
        intervalMs,
        now
    );

    const entryTime = new Date(displayTimes.displayEntryMs).toISOString();
    const exitTime = new Date(displayTimes.displayExitMs).toISOString();

    const candidateType =
        selected.exit_index === currentCandleIndex
            ? 'current_unfinished'
            : selected.exit_index === latestClosedIndex
                ? 'latest_closed'
                : 'recent_window';

    const rewardRiskRatio = selected.sl_distance > 0
        ? selected.tp_distance / selected.sl_distance
        : 0;

    const paperTxHash = `PAPER-${assetSymbol}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    console.log(
        `[TRADE_ENGINE] Selected trade: combo=${selected.combo_label}, slMult=${selected.sl_multiplier}, tpMult=${selected.tpMultiplier}, type=${candidateType}, asset=${assetSymbol}, direction=${selected.direction}, status=${isWin ? 'WIN' : 'LOSS'}, pnl=$${pnlUsd.toFixed(2)}`
    );

    return {
        // Internal/new display status
        status: isWin ? 'WIN' : 'LOSS',

        // Legacy status for existing admin/stats compatibility
        legacy_status: isWin ? 'success' : 'failed',

        market,
        asset: assetName,
        asset_symbol: assetSymbol,
        direction: selected.direction,

        entry_price: round2(selected.entry_price),
        exit_price: round2(selected.outcome.exit_price),

        position_size_usd: round2(positionSizeUsd),
        leverage: round2(leverage),
        risk_percent: round2(riskPercent),

        pnl_usd: round2(pnlUsd),

        // Recent display times.
        entry_time: entryTime,
        exit_time: exitTime,

        tx_hash: paperTxHash,

        metadata: {
            simulation: true,
            engine: 'practical-recent-candles-method-b-multi-tp-sl',
            result: isWin ? 'WIN' : 'LOSS',

            candidate_type: candidateType,
            ultra_strict_latest_only: ULTRA_STRICT_LATEST_ONLY,
            recent_entry_lookback: RECENT_ENTRY_LOOKBACK,
            recent_exit_lookback: RECENT_EXIT_LOOKBACK,

            method_b_multi_tp_sl_search: true,
            selected_combo_label: selected.combo_label,
            selected_sl_multiplier: round2(selected.sl_multiplier),
            selected_tp_multiplier: round2(selected.tp_multiplier),
            reward_risk_ratio: round2(rewardRiskRatio),

            interval,
            interval_ms: intervalMs,

            atr: round2(selected.atr),
            sl_distance: round2(selected.sl_distance),
            tp_distance: round2(selected.tp_distance),
            fee_estimate_usd: round2(fee),

            entry_index: selected.entry_index,
            exit_index: selected.exit_index,

            candidate_wins_available: wins.length,
            candidate_losses_available: losses.length,

            // Debugging / transparency fields.
            raw_entry_time: Number.isFinite(rawEntryMs)
                ? new Date(rawEntryMs).toISOString()
                : null,

            raw_exit_time: Number.isFinite(rawExitMs)
                ? new Date(rawExitMs).toISOString()
                : null,

            display_entry_time: entryTime,
            display_exit_time: exitTime,

            raw_duration_ms: displayTimes.rawDurationMs,
            display_duration_ms: displayTimes.displayDurationMs,
            display_exit_ago_ms: displayTimes.exitAgoMs,

            current_unfinished_candle_present: Boolean(currentCandle)
        },

        // Legacy column helpers
        token: assetName,
        chain: market,
        profit_usd: round2(pnlUsd),
        created_at: exitTime
    };
}

module.exports = {
    simulateTrade
};