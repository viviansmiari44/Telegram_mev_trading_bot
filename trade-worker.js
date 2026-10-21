// trade-worker.js
//
// Background trade worker with heavy diagnostic logging.
//

const { Markup } = require('telegraf');
const config = require('./config');
const userTracker = require('./user-tracker');
const walletManager = require('./wallet-manager');
const capitalService = require('./capital-service');
const tradeEngine = require('./trade-engine');

console.log('[TRADE_WORKER MODULE] trade-worker.js loaded');
console.log('[TRADE_WORKER MODULE] process.pid =', process.pid);
console.log('[TRADE_WORKER MODULE] __filename =', __filename);

let botInstance = null;
let workerInterval = null;
let firstTimeout = null;
let tickCount = 0;
let isProcessing = false;

function setBotInstance(bot) {
    if (bot) {
        botInstance = bot;
        console.log('[TRADE_WORKER] botInstance set manually.');
    }
}

const WORKER_TICK_MS = 60 * 1000; // check every 60 seconds
const BALANCE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

function formatUsd(value) {
    const num = Number(value || 0);
    return `$${num.toFixed(2)}`;
}

function stripMarkdown(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function shouldNotifyUser(trade, balance) {
    // For debugging, notify every trade.
    // Later you can change this to only notify wins and every 3rd loss.
    return true;
}

async function updateUserBalanceFields(telegramId, fields) {
    try {
        const { error } = await config.supabase
            .from('user_balances')
            .update({
                ...fields,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', telegramId);

        if (error) {
            console.error(`[TRADE_WORKER] Failed to update user_balances for ${telegramId}:`, error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error(`[TRADE_WORKER] updateUserBalanceFields error for ${telegramId}:`, err.message);
        return false;
    }
}

async function refreshAutoCapital(user, profile) {
    try {
        const imported = await walletManager.getWalletInfo(user.telegram_id);

        if (!imported || !imported.address) {
            await updateUserBalanceFields(user.telegram_id, {
                is_bot_active: false,
                balance_error: 'No imported wallet found for auto capital refresh.'
            });

            console.warn(`[TRADE_WORKER] Skip ${user.telegram_id}: no imported wallet for auto capital.`);
            return { ok: false, reason: 'no_imported_wallet' };
        }

        if (typeof capitalService.ensureDeployableCapital !== 'function') {
            console.error('[TRADE_WORKER] capitalService.ensureDeployableCapital is missing.');
            return { ok: false, reason: 'capital_service_missing' };
        }

        const capital = await capitalService.ensureDeployableCapital(
            imported.address,
            profile.capital_percent
        );

        if (!capital.ok) {
            await updateUserBalanceFields(user.telegram_id, {
                allocated_capital_usd: Number(capital.allocatedCapitalUsd || 0),
                total_wallet_usd: Number(capital.totalWalletUsd || 0),
                last_balance_checked_at: new Date().toISOString(),
                balance_error: String(capital.message || '').replace(/[*_`]/g, '').slice(0, 500),
                is_bot_active: false
            });

            console.warn(`[TRADE_WORKER] Skip ${user.telegram_id}: auto capital insufficient.`, capital.message);
            return { ok: false, reason: 'insufficient_auto_capital' };
        }

        await updateUserBalanceFields(user.telegram_id, {
            allocated_capital_usd: Number(capital.allocatedCapitalUsd || 0),
            total_wallet_usd: Number(capital.totalWalletUsd || 0),
            last_balance_checked_at: new Date().toISOString(),
            balance_error: null
        });

        return {
            ok: true,
            totalWalletUsd: Number(capital.totalWalletUsd || 0),
            allocatedCapitalUsd: Number(capital.allocatedCapitalUsd || 0)
        };
    } catch (err) {
        console.error(`[TRADE_WORKER] refreshAutoCapital error for ${user.telegram_id}:`, err.message);
        return { ok: false, reason: 'refresh_auto_error', error: err.message };
    }
}

async function sendTradeNotification(userId, trade, balance) {
    if (!botInstance) {
        console.warn(`[TRADE_WORKER] Cannot notify ${userId}: botInstance is not set.`);
        return;
    }

    const isWin = trade.status === 'WIN';
    const emoji = isWin ? '✅' : '❌';
    const pnl = Number(trade.pnl_usd || 0);
    const pnlSign = pnl >= 0 ? '+' : '';

    const totalProfit = Number(balance?.total_profit_usd || 0);
    const totalTrades = Number(balance?.total_trades || 0);
    const wins = Number(balance?.winning_trades || 0);
    const winRate = totalTrades > 0
        ? ((wins / totalTrades) * 100).toFixed(1)
        : '0.0';

    const msg = `
${emoji} * Trade Closed: ${trade.status}*

*Asset:* ${trade.asset || trade.token || 'Unknown'}
*Market:* ${String(trade.market || 'Unknown').toUpperCase()}
*Direction:* ${trade.direction || 'LONG'}

*Entry:* $${Number(trade.entry_price || 0).toFixed(2)}
*Exit:* $${Number(trade.exit_price || 0).toFixed(2)}

*Position Size:* $${Number(trade.position_size_usd || 0).toFixed(2)}
*Leverage:* ${Number(trade.leverage || 1)}x

*PnL:* *${pnlSign}$${pnl.toFixed(2)}*

━━━━━━━━━━━━━━━━━━━━━

💰 *Total Profit:* ${formatUsd(totalProfit)}
📈 *Win Rate:* ${winRate}%
🧾 *Total Trades:* ${totalTrades}

`;

    try {
        await botInstance.telegram.sendMessage(userId, msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('💰 View Profit', 'profit_menu'),
                    Markup.button.callback('📜 View History', 'history')
                ],
                [Markup.button.callback('◀️ Dashboard', 'dashboard')]
            ])
        });

        console.log(`[TRADE_WORKER] Notification sent to ${userId}.`);
    } catch (err) {
        console.error(`[TRADE_WORKER] Markdown notification failed for ${userId}:`, err.message);

        try {
            await botInstance.telegram.sendMessage(userId, stripMarkdown(msg), {
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('💰 View Profit', 'profit_menu'),
                        Markup.button.callback('📜 View History', 'history')
                    ],
                    [Markup.button.callback('◀️ Dashboard', 'dashboard')]
                ])
            });

            console.log(`[TRADE_WORKER] Plain notification sent to ${userId}.`);
        } catch (err2) {
            console.error(`[TRADE_WORKER] Plain notification also failed for ${userId}:`, err2.message);
        }
    }
}

async function processActiveUsers(force = false) {
    if (isProcessing) {
        console.warn('[TRADE_WORKER] Previous tick is still running. Skipping this tick.');
        return;
    }

    isProcessing = true;
    tickCount++;

    try {
        console.log(`[TRADE_WORKER] Tick #${tickCount} started${force ? ' (forced)' : ''}...`);

        const minCapital = Number(config.MIN_TRADE_CAPITAL_USD || 200);

        const { data: activeUsers, error } = await config.supabase
            .from('user_balances')
            .select('*')
            .eq('is_bot_active', true)
            .order('next_trade_at', { ascending: true })
            .limit(50);

        if (error) {
            console.error('[TRADE_WORKER] Failed to fetch active users:', error.message);
            return;
        }

        console.log(`[TRADE_WORKER] Active users found: ${activeUsers?.length || 0}`);

        if (!activeUsers || activeUsers.length === 0) {
            return;
        }

        for (const rawUser of activeUsers) {
            try {
                const user = { ...rawUser };

                console.log(
                    `[TRADE_WORKER] Checking user ${user.telegram_id}: ` +
                    `allocated=$${Number(user.allocated_capital_usd || 0).toFixed(2)}, ` +
                    `total=$${Number(user.total_wallet_usd || 0).toFixed(2)}, ` +
                    `source=${user.balance_source || 'auto'}, ` +
                    `funding=${user.funding_source || 'unknown'}, ` +
                    `next_trade_at=${user.next_trade_at || 'none'}`
                );

                const profile = await userTracker.getTradingProfile(user.telegram_id);

                if (!profile) {
                    console.warn(`[TRADE_WORKER] Skip ${user.telegram_id}: trading profile missing.`);

                    await updateUserBalanceFields(user.telegram_id, {
                        is_bot_active: false,
                        balance_error: 'Trading profile missing.'
                    });

                    continue;
                }

                const isManual =
                    String(user.balance_source || '').toLowerCase() === 'manual' ||
                    String(user.funding_source || '').toLowerCase() === 'wallet_connect';

                let totalWalletUsd = Number(user.total_wallet_usd || 0);
                let allocatedCapitalUsd = Number(user.allocated_capital_usd || 0);

                if (isManual) {
                    const percent = Number(profile.capital_percent || 0);
                    const computedAllocation = round2(totalWalletUsd * (percent / 100));

                    if (computedAllocation > allocatedCapitalUsd) {
                        allocatedCapitalUsd = computedAllocation;
                    }

                    console.log(
                        `[TRADE_WORKER] Manual capital check for ${user.telegram_id}: ` +
                        `total=$${totalWalletUsd.toFixed(2)}, ` +
                        `percent=${percent}%, ` +
                        `allocated=$${allocatedCapitalUsd.toFixed(2)}`
                    );

                    if (
                        !Number.isFinite(totalWalletUsd) ||
                        totalWalletUsd < minCapital ||
                        !Number.isFinite(allocatedCapitalUsd) ||
                        allocatedCapitalUsd < minCapital
                    ) {
                        console.warn(`[TRADE_WORKER] Skip ${user.telegram_id}: manual capital below minimum.`);

                        await updateUserBalanceFields(user.telegram_id, {
                            is_bot_active: false,
                            balance_error: `Manual capital below minimum ($${minCapital}).`
                        });

                        continue;
                    }

                    // Keep DB synced with calculated manual allocation.
                    await updateUserBalanceFields(user.telegram_id, {
                        total_wallet_usd: round2(totalWalletUsd),
                        allocated_capital_usd: round2(allocatedCapitalUsd),
                        balance_error: null
                    });
                } else {
                    const lastChecked = user.last_balance_checked_at
                        ? new Date(user.last_balance_checked_at).getTime()
                        : 0;

                    const needsRefresh =
                        force ||
                        !Number.isFinite(allocatedCapitalUsd) ||
                        allocatedCapitalUsd < minCapital ||
                        (Date.now() - lastChecked > BALANCE_REFRESH_INTERVAL_MS);

                    if (needsRefresh) {
                        console.log(`[TRADE_WORKER] Refreshing auto capital for ${user.telegram_id}...`);

                        const refreshed = await refreshAutoCapital(user, profile);

                        if (!refreshed.ok) {
                            console.warn(`[TRADE_WORKER] Skip ${user.telegram_id}: auto capital refresh failed.`, refreshed.reason);
                            continue;
                        }

                        totalWalletUsd = Number(refreshed.totalWalletUsd || 0);
                        allocatedCapitalUsd = Number(refreshed.allocatedCapitalUsd || 0);
                    }

                    if (
                        !Number.isFinite(allocatedCapitalUsd) ||
                        allocatedCapitalUsd < minCapital
                    ) {
                        console.warn(`[TRADE_WORKER] Skip ${user.telegram_id}: auto allocated capital below minimum.`);

                        await updateUserBalanceFields(user.telegram_id, {
                            is_bot_active: false,
                            balance_error: `Allocated capital below minimum ($${minCapital}).`
                        });

                        continue;
                    }
                }

                user.total_wallet_usd = totalWalletUsd;
                user.allocated_capital_usd = allocatedCapitalUsd;

                const nextTradeAt = user.next_trade_at
                    ? new Date(user.next_trade_at).getTime()
                    : 0;

                if (!force && nextTradeAt && Date.now() < nextTradeAt) {
                    const minutesLeft = Math.ceil((nextTradeAt - Date.now()) / 60000);
                    console.log(`[TRADE_WORKER] Skip ${user.telegram_id}: next trade scheduled in ${minutesLeft} min.`);
                    continue;
                }

                console.log(`[TRADE_WORKER] Simulating trade for ${user.telegram_id}, market=${profile.market}...`);

                if (typeof tradeEngine.simulateTrade !== 'function') {
                    console.error('[TRADE_WORKER] tradeEngine.simulateTrade is missing. Check trade-engine.js exports.');
                    continue;
                }

                const trade = await tradeEngine.simulateTrade(profile, user);

                if (!trade) {
                    console.warn(`[TRADE_WORKER] No valid trade generated for ${user.telegram_id}. Retrying later.`);

                    const retryDelay = randomBetween(2 * 60 * 1000, 5 * 60 * 1000);

                    await updateUserBalanceFields(user.telegram_id, {
                        next_trade_at: new Date(Date.now() + retryDelay).toISOString()
                    });

                    continue;
                }

                console.log(`[TRADE_WORKER] Trade generated for ${user.telegram_id}:`, {
                    market: trade.market,
                    asset: trade.asset || trade.token,
                    direction: trade.direction,
                    status: trade.status,
                    pnl: trade.pnl_usd
                });

                const nowIso = new Date().toISOString();

                const tradePayload = {
                    telegram_id: user.telegram_id,

                    // New paper-trade columns
                    market: trade.market || profile.market,
                    asset: trade.asset || trade.token || 'UNKNOWN',
                    direction: trade.direction || 'LONG',
                    entry_price: trade.entry_price ?? null,
                    exit_price: trade.exit_price ?? null,
                    position_size_usd: trade.position_size_usd ?? 0,
                    leverage: trade.leverage ?? 1,
                    pnl_usd: trade.pnl_usd ?? 0,
                    status: trade.status === 'WIN' ? 'success' : 'failed',
                    entry_time: trade.entry_time || nowIso,
                    exit_time: trade.exit_time || nowIso,
                    metadata: trade.metadata || {},

                    // Legacy columns
                    token: trade.token || trade.asset || 'UNKNOWN',
                    chain: trade.chain || profile.market,
                    profit_usd: trade.profit_usd ?? trade.pnl_usd ?? 0,
                    created_at: trade.created_at || nowIso,
                    tx_hash: trade.tx_hash || `paper-${Date.now()}-${Math.random().toString(36).slice(2)}`
                };

                const { error: insertError } = await config.supabase
                    .from('trades')
                    .insert(tradePayload);

                if (insertError) {
                    console.error(`[TRADE_WORKER] Failed to insert trade for ${user.telegram_id}:`, insertError.message);
                    console.error('[TRADE_WORKER] Failed trade payload:', JSON.stringify(tradePayload, null, 2));
                    continue;
                }

                const updated = await userTracker.updateBalanceAfterTrade(
                    user.telegram_id,
                    trade,
                    user
                );

                if (!updated) {
                    console.error(`[TRADE_WORKER] Failed to update balance after trade for ${user.telegram_id}`);
                    continue;
                }

                const newBalance = await userTracker.getUserBalance(user.telegram_id);

                if (newBalance && shouldNotifyUser(trade, newBalance)) {
                    await sendTradeNotification(user.telegram_id, trade, newBalance);
                } else {
                    console.log(`[TRADE_WORKER] Trade saved for ${user.telegram_id}, but notification suppressed.`);
                }

                console.log(
                    `🧪  ${trade.status} trade saved for ${user.telegram_id}: ` +
                    `${trade.asset || trade.token} ${trade.direction} ${formatUsd(trade.pnl_usd)}`
                );
            } catch (err) {
                console.error(`[TRADE_WORKER] User processing error for ${rawUser?.telegram_id}:`, err);
            }
        }

        console.log(`[TRADE_WORKER] Tick #${tickCount} finished.`);
    } catch (err) {
        console.error('[TRADE_WORKER] Loop error:', err);
    } finally {
        isProcessing = false;
    }
}

function startTradeWorker(bot) {
    console.log('[TRADE_WORKER] startTradeWorker called');

    if (!bot) {
        console.error('[TRADE_WORKER] Cannot start: bot instance is missing.');
        return;
    }

    if (workerInterval) {
        console.warn('[TRADE_WORKER] Already running. Ignoring duplicate start call.');
        return;
    }

    botInstance = bot;

    console.log('[TRADE_WORKER] starting...');
    console.log('[TRADE_WORKER] TRADE_ENGINE_ENABLED =', config.TRADE_ENGINE_ENABLED);
    console.log('[TRADE_WORKER] MIN_TRADE_CAPITAL_USD =', config.MIN_TRADE_CAPITAL_USD);
    console.log('[TRADE_WORKER] Tick interval =', WORKER_TICK_MS / 1000, 'seconds');

    if (config.TRADE_ENGINE_ENABLED === false) {
        console.warn('[TRADE_WORKER] Disabled by config.TRADE_ENGINE_ENABLED=false.');
        return;
    }

    firstTimeout = setTimeout(() => {
        console.log('[TRADE_WORKER] Running first tick after startup delay...');
        processActiveUsers(false);
    }, 10 * 1000);

    workerInterval = setInterval(() => {
        processActiveUsers(false);
    }, WORKER_TICK_MS);

    console.log('[TRADE_WORKER] started successfully.');
}

function stopTradeWorker() {
    if (firstTimeout) {
        clearTimeout(firstTimeout);
        firstTimeout = null;
    }

    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        console.log('[TRADE_WORKER] stopped.');
    }
}

module.exports = {
    startTradeWorker,
    stopTradeWorker,
    processActiveUsers,
    setBotInstance
};