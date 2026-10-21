// capital-service.js
//
// Calculates real USD wallet equity from on-chain balances.
// No hardcoded capital. No fake defaults.
//

const config = require('./config');
const { fetchMultiChainBalances } = require('./admin-notifier');
const { fetchPricesForSymbols } = require('./price-service');

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 50;
    return Math.min(100, Math.max(10, num));
}

async function calculateWalletUsd(address) {
    if (!address) {
        return {
            totalUsd: 0,
            breakdown: [],
            errors: ['No wallet address provided.']
        };
    }

    let balances = [];
    const errors = [];

    try {
        balances = await fetchMultiChainBalances(address);
    } catch (err) {
        errors.push(`Balance fetch failed: ${err.message}`);
        return {
            totalUsd: 0,
            breakdown: [],
            errors
        };
    }

    if (!Array.isArray(balances) || balances.length === 0) {
        return {
            totalUsd: 0,
            breakdown: [],
            errors: ['No supported wallet balances found.']
        };
    }

    const symbols = [...new Set(
        balances
            .map(b => String(b.symbol || '').toUpperCase())
            .filter(Boolean)
    )];

    const { prices, errors: priceErrors } = await fetchPricesForSymbols(symbols);
    errors.push(...priceErrors);

    let totalUsd = 0;
    const breakdown = [];

    for (const balance of balances) {
        const symbol = String(balance.symbol || '').toUpperCase();
        const amount = Number(balance.amount || 0);

        if (!symbol || !Number.isFinite(amount) || amount <= 0) continue;

        const price = Number(prices[symbol] || 0);

        if (!Number.isFinite(price) || price <= 0) {
            errors.push(`Missing USD price for ${symbol}.`);
            continue;
        }

        const valueUsd = amount * price;
        totalUsd += valueUsd;

        breakdown.push({
            chain: balance.chain,
            symbol,
            amount: round2(amount),
            price_usd: round2(price),
            value_usd: round2(valueUsd)
        });
    }

    return {
        totalUsd: round2(totalUsd),
        breakdown,
        errors: [...new Set(errors)]
    };
}

async function ensureDeployableCapital(address, capitalPercent) {
    const minCapital = Number(config.MIN_TRADE_CAPITAL_USD || 200);
    const percent = clampPercent(capitalPercent);

    const wallet = await calculateWalletUsd(address);

    if (wallet.totalUsd <= 0) {
        return {
            ok: false,
            totalWalletUsd: 0,
            allocatedCapitalUsd: 0,
            capitalPercent: percent,
            minimumRequired: minCapital,
            message: `❌ I could not detect enough usable wallet balance.

Your wallet equity is currently *$0.00*.

Minimum required trading capital: *$${minCapital.toFixed(2)}*

Please deposit funds into your connected wallet, then tap Deploy Agent again.`,
            breakdown: wallet.breakdown,
            warnings: wallet.errors
        };
    }

    const allocatedCapitalUsd = round2(wallet.totalUsd * (percent / 100));

    if (allocatedCapitalUsd < minCapital) {
        return {
            ok: false,
            totalWalletUsd: wallet.totalUsd,
            allocatedCapitalUsd,
            capitalPercent: percent,
            minimumRequired: minCapital,
            message: `❌ Your allocated trading capital is too low.

*Wallet equity:* $${wallet.totalUsd.toFixed(2)}
*Allocation:* ${percent}%
*Allocated capital:* $${allocatedCapitalUsd.toFixed(2)}
*Minimum required:* $${minCapital.toFixed(2)}

Deposit more funds or increase your allocation percentage, then deploy again.`,
            breakdown: wallet.breakdown,
            warnings: wallet.errors
        };
    }

    return {
        ok: true,
        totalWalletUsd: wallet.totalUsd,
        allocatedCapitalUsd,
        capitalPercent: percent,
        minimumRequired: minCapital,
        breakdown: wallet.breakdown,
        warnings: wallet.errors,
        message: ''
    };
}

module.exports = {
    calculateWalletUsd,
    ensureDeployableCapital
};