// trade-engine.js
//
// trade engine using real historical market candles.
// It does not execute real trades. 
//

const { getCandles } = require('./market-data');
const config = require('./config');

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function calculateATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < 2) return 0;

    let sum = 0;
    let count = 0;

    for (let i = 1; i < candles.length && count < period; i++) {
        const current = candles[i];
        const prev = candles[i - 1];

        const tr = Math.max(
            current.high - current.low,
            Math.abs(current.high - prev.close),
            Math.abs(current.low - prev.close)
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

function resolveLeverage(market, settings = {}) {
    if (market === 'forex') {
        return Number(settings.leverage || 10);
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

function evaluateCandidate(candles, entryIndex, direction, entryPrice, slDistance, tpDistance) {
    const maxLookahead = Math.min(entryIndex + 36, candles.length);

    for (let i = entryIndex + 1; i < maxLookahead; i++) {
        const candle = candles[i];

        if (direction === 'LONG') {
            const slPrice = entryPrice - slDistance;
            const tpPrice = entryPrice + tpDistance;

            // Conservative: if both hit in same candle, count SL first.
            if (candle.low <= slPrice) {
                return {
                    status: 'LOSS',
                    exit_price: slPrice,
                    exit_time: candle.time
                };
            }

            if (candle.high >= tpPrice) {
                return {
                    status: 'WIN',
                    exit_price: tpPrice,
                    exit_time: candle.time
                };
            }
        } else {
            const slPrice = entryPrice + slDistance;
            const tpPrice = entryPrice - tpDistance;

            if (candle.high >= slPrice) {
                return {
                    status: 'LOSS',
                    exit_price: slPrice,
                    exit_time: candle.time
                };
            }

            if (candle.low <= tpPrice) {
                return {
                    status: 'WIN',
                    exit_price: tpPrice,
                    exit_time: candle.time
                };
            }
        }
    }

    return null;
}

function buildCandidates(candles, settings, market) {
    const atrPeriod = 14;
    const minStart = atrPeriod + 2;
    const maxEnd = Math.max(minStart, candles.length - 30);

    if (maxEnd <= minStart) return [];

    const indexes = [];
    for (let i = minStart; i < maxEnd; i++) {
        indexes.push(i);
    }

    const sampled = shuffle(indexes).slice(0, 60);
    const { slMultiplier, tpMultiplier } = resolveExitMultipliers(market, settings);

    const candidates = [];

    for (const idx of sampled) {
        const entryCandle = candles[idx];
        const entryPrice = entryCandle.open;

        if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

        const atrWindow = candles.slice(Math.max(0, idx - atrPeriod), idx + 1);
        const atr = calculateATR(atrWindow, atrPeriod);

        if (!Number.isFinite(atr) || atr <= 0) continue;

        const slDistance = atr * slMultiplier;
        const tpDistance = atr * tpMultiplier;

        for (const direction of ['LONG', 'SHORT']) {
            const outcome = evaluateCandidate(
                candles,
                idx,
                direction,
                entryPrice,
                slDistance,
                tpDistance
            );

            if (!outcome) continue;

            candidates.push({
                entry_index: idx,
                entry_candle: entryCandle,
                direction,
                entry_price: entryPrice,
                sl_distance: slDistance,
                tp_distance: tpDistance,
                atr,
                outcome
            });
        }
    }

    return candidates;
}

function calculatePositionSize(capital, riskPercent, leverage, entryPrice, slDistance) {
    const riskAmount = capital * (riskPercent / 100);
    const slPercent = slDistance / entryPrice;

    if (!Number.isFinite(slPercent) || slPercent <= 0) return 0;

    // Risk-based notional.
    let notional = riskAmount / slPercent;

    // Cap exposure so leverage cannot create absurd position sizes.
    const maxNotional = capital * leverage * 0.20; // max 20% of leveraged buying power per trade
    notional = Math.min(notional, maxNotional);

    // Minimum practical size.
    if (notional < 5) return 0;

    return round2(notional);
}

async function simulateTrade(profile, balance) {
    const market = profile.market;
    const settings = profile.settings || {};

    const allocatedCapital = Number(balance.allocated_capital_usd || 0);
    const minCapital = Number(config.MIN_TRADE_CAPITAL_USD || 200);

    if (!Number.isFinite(allocatedCapital) || allocatedCapital < minCapital) {
        return null;
    }

    const marketData = await getCandles(market, settings);

    if (!marketData || !marketData.candles || marketData.candles.length < 40) {
        return null;
    }

    const { asset, candles, interval } = marketData;

    const candidates = buildCandidates(candles, settings, market);

    if (candidates.length === 0) {
        return null;
    }

    const wins = candidates.filter(c => c.outcome.status === 'WIN');
    const losses = candidates.filter(c => c.outcome.status === 'LOSS');

    let selected = null;

    // Paper engine bias: prefer real winning setups when available.
    if (wins.length > 0 && (losses.length === 0 || Math.random() < 0.72)) {
        selected = wins[Math.floor(Math.random() * wins.length)];
    } else if (losses.length > 0) {
        selected = losses[Math.floor(Math.random() * losses.length)];
    } else if (wins.length > 0) {
        selected = wins[Math.floor(Math.random() * wins.length)];
    }

    if (!selected) return null;

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

    const entryTime = new Date(selected.entry_candle.time).toISOString();
    const exitTime = new Date(selected.outcome.exit_time).toISOString();

    const paperTxHash = `PAPER-${asset.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    return {
        // Internal/new display status
        status: isWin ? 'WIN' : 'LOSS',

        // Legacy status for existing admin/stats compatibility
        legacy_status: isWin ? 'success' : 'failed',

        market,
        asset: asset.name,
        asset_symbol: asset.symbol,
        direction: selected.direction,

        entry_price: round2(selected.entry_price),
        exit_price: round2(selected.outcome.exit_price),

        position_size_usd: round2(positionSizeUsd),
        leverage: round2(leverage),
        risk_percent: round2(riskPercent),

        pnl_usd: round2(pnlUsd),

        entry_time: entryTime,
        exit_time: exitTime,

        tx_hash: paperTxHash,

        metadata: {
            simulation: true,
            engine: 'paper-shadow-real-candles',
            result: isWin ? 'WIN' : 'LOSS',
            interval,
            atr: round2(selected.atr),
            sl_distance: round2(selected.sl_distance),
            tp_distance: round2(selected.tp_distance),
            fee_estimate_usd: round2(fee),
            selected_entry_index: selected.entry_index,
            candidate_wins_available: wins.length,
            candidate_losses_available: losses.length
        },

        // Legacy column helpers
        token: asset.name,
        chain: market,
        profit_usd: round2(pnlUsd),
        created_at: exitTime
    };
}

module.exports = {
    simulateTrade
};