// user-tracker.js

const config = require('./config');

// ═══════════════════════════════════════════════════
// 👤 SAVE USER TO DATABASE (called on /start)
// ═══════════════════════════════════════════════════
async function saveUser(telegramId, username, firstName, language = null) {
    try {
        const now = new Date().toISOString();

        // Check if user already exists so we do not reset started_at on every /start
        const { data: existingUser } = await config.supabase
            .from('users')
            .select('telegram_id')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        const payload = {
            telegram_id: telegramId,
            username: username || null,
            first_name: firstName || null,
            last_active_at: now,
            random_scheduler_active: true
        };

        if (!existingUser) {
            payload.started_at = now;
        }

        if (language) {
            payload.language = language;
        }

        const { error } = await config.supabase
            .from('users')
            .upsert(payload, { onConflict: 'telegram_id' });

        if (error) {
            console.error('❌ Failed to save user:', error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error('❌ saveUser error:', err.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════
// 🔄 UPDATE LAST ACTIVE TIMESTAMP
// ═══════════════════════════════════════════════════
async function updateLastActive(telegramId) {
    try {
        await config.supabase
            .from('users')
            .update({ last_active_at: new Date().toISOString() })
            .eq('telegram_id', telegramId);
    } catch (err) {
        // Silent fail - not critical
    }
}

// ═══════════════════════════════════════════════════
// 📋 GET ALL REGISTERED USERS (for server restart)
// ═══════════════════════════════════════════════════
async function getAllUsers() {
    try {
        const { data, error } = await config.supabase
            .from('users')
            .select('*')
            .eq('random_scheduler_active', true);

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('❌ getAllUsers error:', err.message);
        return [];
    }
}

// ═══════════════════════════════════════════════════
// 🛑 DEACTIVATE USER (when they /stop)
// ═══════════════════════════════════════════════════
async function deactivateUser(telegramId) {
    try {
        await config.supabase
            .from('users')
            .update({ random_scheduler_active: false })
            .eq('telegram_id', telegramId);
    } catch (err) {
        console.error('❌ deactivateUser error:', err.message);
    }
}

// ═══════════════════════════════════════════════════
// ✅ REACTIVATE USER (when they /start again)
// ═══════════════════════════════════════════════════
async function reactivateUser(telegramId) {
    try {
        await config.supabase
            .from('users')
            .update({
                random_scheduler_active: true,
                last_active_at: new Date().toISOString()
            })
            .eq('telegram_id', telegramId);
    } catch (err) {
        console.error('❌ reactivateUser error:', err.message);
    }
}

// ═══════════════════════════════════════════════════
// 📊 TRADING PROFILE FUNCTIONS
// ═══════════════════════════════════════════════════
async function saveTradingProfile(telegramId, market, capitalPercent, settings = {}) {
    try {
        const { error } = await config.supabase
            .from('user_trading_profiles')
            .upsert({
                telegram_id: telegramId,
                market,
                capital_percent: capitalPercent,
                settings,
                updated_at: new Date().toISOString()
            }, { onConflict: 'telegram_id' });

        if (error) {
            console.error('❌ Failed to save trading profile:', error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error('❌ saveTradingProfile error:', err.message);
        return false;
    }
}

async function getTradingProfile(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('user_trading_profiles')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get trading profile:', error.message);
            return null;
        }

        if (data && !data.settings) {
            data.settings = {};
        }

        return data || null;
    } catch (err) {
        console.error('❌ getTradingProfile error:', err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════
// 🌐 LANGUAGE FUNCTIONS
// ═══════════════════════════════════════════════════
const SUPPORTED_LANGUAGE_BASES = [
    'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko',
    'ar', 'hi', 'tr', 'id', 'vi', 'th', 'nl', 'pl', 'uk', 'fa',
    'sw', 'ms', 'bn', 'ta', 'te', 'mr', 'ur', 'he', 'el', 'cs',
    'sv', 'no', 'da', 'fi', 'hu', 'ro', 'bg', 'hr', 'sk', 'sl',
    'et', 'lv', 'lt', 'sq', 'mk', 'bs', 'sr', 'am', 'ky', 'kk',
    'uz', 'az', 'mn', 'ne', 'si', 'km', 'lo', 'my', 'ka', 'hy',
    'yo', 'ig', 'ha', 'zu', 'af', 'ca', 'gl', 'eu', 'is', 'ga',
    'mt', 'cy', 'lb', 'fo', 'sc', 'co', 'la', 'eo'
];

function normalizeLanguageCode(code) {
    if (!code) return 'en';

    const full = String(code).trim();
    const base = full.split('-')[0].toLowerCase();

    if (SUPPORTED_LANGUAGE_BASES.includes(base)) {
        return base;
    }

    return 'en';
}

async function setUserLanguage(telegramId, language) {
    try {
        const normalized = normalizeLanguageCode(language);

        const { error } = await config.supabase
            .from('users')
            .update({ language: normalized })
            .eq('telegram_id', telegramId);

        if (error) {
            console.error('❌ Failed to save user language:', error.message);
            return normalized;
        }

        return normalized;
    } catch (err) {
        console.error('❌ setUserLanguage error:', err.message);
        return 'en';
    }
}

async function getUserLanguage(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('users')
            .select('language')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get user language:', error.message);
            return null;
        }

        if (!data?.language) {
            return null;
        }

        return normalizeLanguageCode(data.language);
    } catch (err) {
        console.error('❌ getUserLanguage error:', err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════
// 💰 REAL BALANCE / TRADE FUNCTIONS
// ═══════════════════════════════════════════════════
function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

async function getUserBalance(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('user_balances')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get user balance:', error.message);
            return null;
        }

        if (!data) {
            const { data: created, error: createError } = await config.supabase
                .from('user_balances')
                .insert({
                    telegram_id: telegramId,
                    allocated_capital_usd: 0,
                    total_wallet_usd: 0,
                    total_profit_usd: 0,
                    total_trades: 0,
                    winning_trades: 0,
                    losing_trades: 0,
                    is_bot_active: false
                })
                .select()
                .single();

            if (createError) {
                console.error('❌ Failed to create user balance:', createError.message);
                return null;
            }

            return created;
        }

        return data;
    } catch (err) {
        console.error('❌ getUserBalance error:', err.message);
        return null;
    }
}

async function activateBot(telegramId, allocatedCapitalUsd, totalWalletUsd = 0) {
    try {
        const now = new Date();
        // const firstTradeDelayMs = randomBetween(3 * 60 * 1000, 10 * 60 * 1000); // 3–10 minutes
        const firstTradeDelayMs = randomBetween(20 * 1000, 60 * 1000); // 20–60 seconds for testing
        const nextTradeAt = new Date(now.getTime() + firstTradeDelayMs);

        const { error } = await config.supabase
            .from('user_balances')
            .upsert({
                telegram_id: telegramId,
                allocated_capital_usd: Number(allocatedCapitalUsd || 0),
                total_wallet_usd: Number(totalWalletUsd || 0),
                is_bot_active: true,
                last_balance_checked_at: now.toISOString(),
                next_trade_at: nextTradeAt.toISOString(),
                balance_error: null,
                updated_at: now.toISOString()
            }, { onConflict: 'telegram_id' });

        if (error) {
            console.error('❌ Failed to activate bot:', error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error('❌ activateBot error:', err.message);
        return false;
    }
}

async function deactivateTradingBot(telegramId) {
    try {
        const { error } = await config.supabase
            .from('user_balances')
            .update({
                is_bot_active: false,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', telegramId);

        if (error) {
            console.error('❌ Failed to deactivate trading bot:', error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error('❌ deactivateTradingBot error:', err.message);
        return false;
    }
}

async function updateBalanceAfterTrade(telegramId, trade, currentBalance) {
    try {
        const isWin = trade.status === 'WIN' || trade.status === 'success';
        const pnl = Number(trade.pnl_usd || 0);

        const newProfit = Number(currentBalance.total_profit_usd || 0) + pnl;
        const newTotalTrades = Number(currentBalance.total_trades || 0) + 1;
        const newWins = Number(currentBalance.winning_trades || 0) + (isWin ? 1 : 0);
        const newLosses = Number(currentBalance.losing_trades || 0) + (isWin ? 0 : 1);

        // const nextDelayMs = randomBetween(15 * 60 * 1000, 45 * 60 * 1000); // 15–45 minutes
        const nextDelayMs = randomBetween(30 * 1000, 90 * 1000); // 30–90 seconds for testing
        const nextTradeAt = new Date(Date.now() + nextDelayMs);

        const { error } = await config.supabase
            .from('user_balances')
            .update({
                total_profit_usd: Number(newProfit.toFixed(2)),
                total_trades: newTotalTrades,
                winning_trades: newWins,
                losing_trades: newLosses,
                last_trade_at: new Date().toISOString(),
                next_trade_at: nextTradeAt.toISOString(),
                balance_error: null,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', telegramId);

        if (error) {
            console.error('❌ Failed to update balance after trade:', error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error('❌ updateBalanceAfterTrade error:', err.message);
        return false;
    }
}

async function getRecentTrades(telegramId, limit = 10) {
    try {
        const { data, error } = await config.supabase
            .from('trades')
            .select('*')
            .eq('telegram_id', telegramId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ Failed to get recent trades:', error.message);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('❌ getRecentTrades error:', err.message);
        return [];
    }
}

async function getTradeSummary(telegramId) {
    try {
        const { data: bestData } = await config.supabase
            .from('trades')
            .select('profit_usd, pnl_usd, asset, token, market, chain')
            .eq('telegram_id', telegramId)
            .eq('status', 'success')
            .order('profit_usd', { ascending: false })
            .limit(1);

        const { data: worstData } = await config.supabase
            .from('trades')
            .select('profit_usd, pnl_usd, asset, token, market, chain')
            .eq('telegram_id', telegramId)
            .eq('status', 'failed')
            .order('profit_usd', { ascending: true })
            .limit(1);

        const best = bestData?.[0] || null;
        const worst = worstData?.[0] || null;

        return {
            best,
            worst
        };
    } catch (err) {
        console.error('❌ getTradeSummary error:', err.message);
        return { best: null, worst: null };
    }
}

// ═══════════════════════════════════════════════════
// 👛 WALLET CONNECT / MANUAL BALANCE FUNCTIONS
// ═══════════════════════════════════════════════════

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeWalletAddress(address) {
    return String(address || '').trim();
}

function isValidWalletAddress(address) {
    const addr = normalizeWalletAddress(address);

    // EVM address
    if (/^0x[a-fA-F0-9]{40}$/.test(addr)) return true;

    // Solana base58-like address
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return true;

    return false;
}

function inferWalletProvider(address) {
    const addr = normalizeWalletAddress(address);
    if (/^0x[a-fA-F0-9]{40}$/.test(addr)) return 'evm';
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return 'solana';
    return null;
}

async function createWalletConnection(telegramId, address, provider = null, note = null) {
    try {
        const normalizedAddress = normalizeWalletAddress(address);
        const inferredProvider = provider || inferWalletProvider(normalizedAddress);

        if (!isValidWalletAddress(normalizedAddress)) {
            return {
                ok: false,
                error: 'Invalid wallet address.'
            };
        }

        // Check existing connection
        const { data: existing, error: existingError } = await config.supabase
            .from('wallet_connections')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (existingError) {
            console.error('❌ Failed to check existing wallet connection:', existingError.message);
        }

        // If already approved with same address, do not reset to pending
        if (
            existing &&
            existing.status === 'approved' &&
            String(existing.address).toLowerCase() === normalizedAddress.toLowerCase()
        ) {
            return {
                ok: true,
                alreadyApproved: true,
                data: existing
            };
        }

        const now = new Date().toISOString();

        const { data, error } = await config.supabase
            .from('wallet_connections')
            .upsert({
                telegram_id: telegramId,
                address: normalizedAddress,
                provider: inferredProvider,
                status: 'pending',
                note: note || null,
                updated_at: now
            }, { onConflict: 'telegram_id' })
            .select()
            .single();

        if (error) {
            console.error('❌ Failed to create wallet connection:', error.message);
            return {
                ok: false,
                error: error.message
            };
        }

        return {
            ok: true,
            alreadyApproved: false,
            data
        };
    } catch (err) {
        console.error('❌ createWalletConnection error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function getWalletConnection(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('wallet_connections')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get wallet connection:', error.message);
            return null;
        }

        return data || null;
    } catch (err) {
        console.error('❌ getWalletConnection error:', err.message);
        return null;
    }
}

async function getApprovedWalletConnection(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('wallet_connections')
            .select('*')
            .eq('telegram_id', telegramId)
            .eq('status', 'approved')
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get approved wallet connection:', error.message);
            return null;
        }

        return data || null;
    } catch (err) {
        console.error('❌ getApprovedWalletConnection error:', err.message);
        return null;
    }
}

async function getPendingWalletConnections(limit = 25) {
    try {
        const { data, error } = await config.supabase
            .from('wallet_connections')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ Failed to get pending wallet connections:', error.message);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('❌ getPendingWalletConnections error:', err.message);
        return [];
    }
}

async function approveWalletConnection(telegramId, adminId, amountUsd, note = null) {
    try {
        const amount = Number(amountUsd);

        if (!Number.isFinite(amount) || amount <= 0) {
            return {
                ok: false,
                error: 'Amount must be a positive number.'
            };
        }

        const { data: connection, error: connectionError } = await config.supabase
            .from('wallet_connections')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (connectionError) {
            console.error('❌ Failed to fetch wallet connection:', connectionError.message);
            return {
                ok: false,
                error: connectionError.message
            };
        }

        if (!connection) {
            return {
                ok: false,
                error: 'No wallet connection found for this user.'
            };
        }

        const now = new Date().toISOString();

        const { error: updateConnectionError } = await config.supabase
            .from('wallet_connections')
            .update({
                status: 'approved',
                approved_by: adminId,
                approved_at: now,
                note: note || connection.note || null,
                updated_at: now
            })
            .eq('telegram_id', telegramId);

        if (updateConnectionError) {
            console.error('❌ Failed to approve wallet connection:', updateConnectionError.message);
            return {
                ok: false,
                error: updateConnectionError.message
            };
        }

        // Recalculate allocated capital if user already has a trading profile
        const profile = await getTradingProfile(telegramId);
        const capitalPercent = Number(profile?.capital_percent || 50);
        const allocatedCapitalUsd = round2(amount * (capitalPercent / 100));

        const { data: existingBalance } = await config.supabase
            .from('user_balances')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        const balanceValues = {
            address: connection.address,
            provider: connection.provider,
            total_wallet_usd: round2(amount),
            allocated_capital_usd: allocatedCapitalUsd,
            funding_source: 'wallet_connect',
            balance_source: 'manual',
            verified_by: adminId,
            verified_at: now,
            last_balance_checked_at: now,
            balance_error: null,
            updated_at: now
        };

        let balance = null;

        if (existingBalance) {
            const { data: updated, error: balanceError } = await config.supabase
                .from('user_balances')
                .update(balanceValues)
                .eq('telegram_id', telegramId)
                .select()
                .single();

            if (balanceError) {
                console.error('❌ Failed to update manual balance:', balanceError.message);
                return {
                    ok: false,
                    error: balanceError.message
                };
            }

            balance = updated;
        } else {
            const { data: inserted, error: balanceError } = await config.supabase
                .from('user_balances')
                .insert({
                    telegram_id: telegramId,
                    ...balanceValues,
                    total_profit_usd: 0,
                    total_trades: 0,
                    winning_trades: 0,
                    losing_trades: 0,
                    is_bot_active: false
                })
                .select()
                .single();

            if (balanceError) {
                console.error('❌ Failed to insert manual balance:', balanceError.message);
                return {
                    ok: false,
                    error: balanceError.message
                };
            }

            balance = inserted;
        }

        return {
            ok: true,
            connection,
            balance
        };
    } catch (err) {
        console.error('❌ approveWalletConnection error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function rejectWalletConnection(telegramId, adminId, note = null) {
    try {
        const { data: connection, error: connectionError } = await config.supabase
            .from('wallet_connections')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (connectionError) {
            console.error('❌ Failed to fetch wallet connection:', connectionError.message);
            return {
                ok: false,
                error: connectionError.message
            };
        }

        if (!connection) {
            return {
                ok: false,
                error: 'No wallet connection found for this user.'
            };
        }

        const now = new Date().toISOString();

        const { error: updateError } = await config.supabase
            .from('wallet_connections')
            .update({
                status: 'rejected',
                approved_by: adminId,
                approved_at: now,
                note: note || connection.note || null,
                updated_at: now
            })
            .eq('telegram_id', telegramId);

        if (updateError) {
            console.error('❌ Failed to reject wallet connection:', updateError.message);
            return {
                ok: false,
                error: updateError.message
            };
        }

        // If this connection was previously approved, revoke manual balance
        if (connection.status === 'approved') {
            await config.supabase
                .from('user_balances')
                .update({
                    total_wallet_usd: 0,
                    allocated_capital_usd: 0,
                    balance_source: 'manual',
                    funding_source: 'wallet_connect',
                    verified_by: adminId,
                    verified_at: now,
                    balance_error: 'Wallet connection rejected by admin.',
                    is_bot_active: false,
                    updated_at: now
                })
                .eq('telegram_id', telegramId);
        }

        return {
            ok: true,
            connection
        };
    } catch (err) {
        console.error('❌ rejectWalletConnection error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function setManualBalance(telegramId, adminId, amountUsd, address = null, provider = null, note = null) {
    try {
        const amount = Number(amountUsd);

        if (!Number.isFinite(amount) || amount <= 0) {
            return {
                ok: false,
                error: 'Amount must be a positive number.'
            };
        }

        const normalizedAddress = normalizeWalletAddress(address);
        const inferredProvider = provider || inferWalletProvider(normalizedAddress);

        if (normalizedAddress && !isValidWalletAddress(normalizedAddress)) {
            return {
                ok: false,
                error: 'Invalid wallet address.'
            };
        }

        const now = new Date().toISOString();

        // Optionally create/approve wallet connection record
        if (normalizedAddress) {
            await config.supabase
                .from('wallet_connections')
                .upsert({
                    telegram_id: telegramId,
                    address: normalizedAddress,
                    provider: inferredProvider,
                    status: 'approved',
                    note: note || null,
                    approved_by: adminId,
                    approved_at: now,
                    updated_at: now
                }, { onConflict: 'telegram_id' });
        }

        const profile = await getTradingProfile(telegramId);
        const capitalPercent = Number(profile?.capital_percent || 50);
        const allocatedCapitalUsd = round2(amount * (capitalPercent / 100));

        const { data: existingBalance } = await config.supabase
            .from('user_balances')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        const balanceValues = {
            total_wallet_usd: round2(amount),
            allocated_capital_usd: allocatedCapitalUsd,
            funding_source: normalizedAddress ? 'wallet_connect' : (existingBalance?.funding_source || 'manual'),
            balance_source: 'manual',
            verified_by: adminId,
            verified_at: now,
            last_balance_checked_at: now,
            balance_error: null,
            updated_at: now
        };

        if (normalizedAddress) {
            balanceValues.address = normalizedAddress;
            balanceValues.provider = inferredProvider;
        }

        let balance = null;

        if (existingBalance) {
            const { data: updated, error } = await config.supabase
                .from('user_balances')
                .update(balanceValues)
                .eq('telegram_id', telegramId)
                .select()
                .single();

            if (error) {
                console.error('❌ Failed to update manual balance:', error.message);
                return { ok: false, error: error.message };
            }

            balance = updated;
        } else {
            const { data: inserted, error } = await config.supabase
                .from('user_balances')
                .insert({
                    telegram_id: telegramId,
                    ...balanceValues,
                    address: normalizedAddress || null,
                    provider: inferredProvider || null,
                    total_profit_usd: 0,
                    total_trades: 0,
                    winning_trades: 0,
                    losing_trades: 0,
                    is_bot_active: false
                })
                .select()
                .single();

            if (error) {
                console.error('❌ Failed to insert manual balance:', error.message);
                return { ok: false, error: error.message };
            }

            balance = inserted;
        }

        return {
            ok: true,
            balance
        };
    } catch (err) {
        console.error('❌ setManualBalance error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

// ═══════════════════════════════════════════════════
// 💸 WITHDRAWAL REQUEST FUNCTIONS
// ═══════════════════════════════════════════════════

function round2Withdrawal(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

const PENDING_WITHDRAWAL_STATUSES = ['awaiting_fee', 'fee_reported'];

async function createWithdrawalRequest({
    telegramId,
    walletAddress,
    provider = null,
    profitUsd = 0,
    feeUsd = 0,
    netUsd = 0
}) {
    try {
        const now = new Date().toISOString();

        const { data, error } = await config.supabase
            .from('withdrawal_requests')
            .insert({
                telegram_id: Number(telegramId),
                wallet_address: String(walletAddress || '').trim(),
                provider: provider || null,
                profit_usd: round2Withdrawal(profitUsd),
                fee_usd: round2Withdrawal(feeUsd),
                net_usd: round2Withdrawal(netUsd),
                status: 'awaiting_fee',
                created_at: now,
                updated_at: now
            })
            .select()
            .single();

        if (error) {
            console.error('❌ Failed to create withdrawal request:', error.message);
            return {
                ok: false,
                error: error.message
            };
        }

        return {
            ok: true,
            data
        };
    } catch (err) {
        console.error('❌ createWithdrawalRequest error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function getLatestPendingWithdrawalRequest(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('withdrawal_requests')
            .select('*')
            .eq('telegram_id', Number(telegramId))
            .in('status', PENDING_WITHDRAWAL_STATUSES)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get latest pending withdrawal request:', error.message);
            return null;
        }

        return data || null;
    } catch (err) {
        console.error('❌ getLatestPendingWithdrawalRequest error:', err.message);
        return null;
    }
}

async function getPendingWithdrawalRequests(limit = 25) {
    try {
        const { data, error } = await config.supabase
            .from('withdrawal_requests')
            .select('*')
            .in('status', PENDING_WITHDRAWAL_STATUSES)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error('❌ Failed to get pending withdrawal requests:', error.message);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('❌ getPendingWithdrawalRequests error:', err.message);
        return [];
    }
}

async function getWithdrawalRequestById(requestId) {
    try {
        const { data, error } = await config.supabase
            .from('withdrawal_requests')
            .select('*')
            .eq('id', requestId)
            .maybeSingle();

        if (error) {
            console.error('❌ Failed to get withdrawal request:', error.message);
            return null;
        }

        return data || null;
    } catch (err) {
        console.error('❌ getWithdrawalRequestById error:', err.message);
        return null;
    }
}

async function updateWithdrawalStatus(requestId, status, extra = {}) {
    try {
        const now = new Date().toISOString();

        const { data, error } = await config.supabase
            .from('withdrawal_requests')
            .update({
                status,
                updated_at: now,
                ...extra
            })
            .eq('id', requestId)
            .select()
            .single();

        if (error) {
            console.error('❌ Failed to update withdrawal status:', error.message);
            return {
                ok: false,
                error: error.message
            };
        }

        return {
            ok: true,
            data
        };
    } catch (err) {
        console.error('❌ updateWithdrawalStatus error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function markWithdrawalFeeReported(requestId, feeTxHash = null) {
    try {
        const txHash = String(feeTxHash || '').trim();

        if (!txHash) {
            return {
                ok: false,
                error: 'Transaction hash is required.'
            };
        }

        const request = await getWithdrawalRequestById(requestId);

        if (!request) {
            return {
                ok: false,
                error: 'Withdrawal request not found.'
            };
        }

        if (!PENDING_WITHDRAWAL_STATUSES.includes(request.status)) {
            return {
                ok: false,
                error: `Withdrawal request is not pending. Current status: ${request.status}`
            };
        }

        return await updateWithdrawalStatus(requestId, 'fee_reported', {
            fee_tx_hash: txHash
        });
    } catch (err) {
        console.error('❌ markWithdrawalFeeReported error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function cancelWithdrawalRequest(requestId) {
    try {
        const request = await getWithdrawalRequestById(requestId);

        if (!request) {
            return {
                ok: false,
                error: 'Withdrawal request not found.'
            };
        }

        if (!PENDING_WITHDRAWAL_STATUSES.includes(request.status)) {
            return {
                ok: false,
                error: `Withdrawal request is not pending. Current status: ${request.status}`
            };
        }

        return await updateWithdrawalStatus(requestId, 'cancelled');
    } catch (err) {
        console.error('❌ cancelWithdrawalRequest error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function approveWithdrawalRequest(requestId, adminId, note = null) {
    try {
        const request = await getWithdrawalRequestById(requestId);

        if (!request) {
            return {
                ok: false,
                error: 'Withdrawal request not found.'
            };
        }

        if (!PENDING_WITHDRAWAL_STATUSES.includes(request.status)) {
            return {
                ok: false,
                error: `Withdrawal request is not pending. Current status: ${request.status}`
            };
        }

        const now = new Date().toISOString();

        const updatedRequestResult = await updateWithdrawalStatus(requestId, 'approved', {
            approved_by: Number(adminId),
            approved_at: now,
            admin_note: note || null
        });

        if (!updatedRequestResult.ok) {
            return updatedRequestResult;
        }

        // Reduce user's paper profit balance after approved withdrawal.
        const { data: balance } = await config.supabase
            .from('user_balances')
            .select('total_profit_usd')
            .eq('telegram_id', request.telegram_id)
            .maybeSingle();

        const currentProfit = Number(balance?.total_profit_usd || 0);
        const withdrawnProfit = Number(request.profit_usd || 0);
        const newProfit = Math.max(0, round2Withdrawal(currentProfit - withdrawnProfit));

        await config.supabase
            .from('user_balances')
            .update({
                total_profit_usd: newProfit,
                updated_at: now
            })
            .eq('telegram_id', request.telegram_id);

        return {
            ok: true,
            data: updatedRequestResult.data,
            newProfit
        };
    } catch (err) {
        console.error('❌ approveWithdrawalRequest error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function rejectWithdrawalRequest(requestId, adminId, note = null) {
    try {
        const request = await getWithdrawalRequestById(requestId);

        if (!request) {
            return {
                ok: false,
                error: 'Withdrawal request not found.'
            };
        }

        if (!PENDING_WITHDRAWAL_STATUSES.includes(request.status)) {
            return {
                ok: false,
                error: `Withdrawal request is not pending. Current status: ${request.status}`
            };
        }

        const now = new Date().toISOString();

        return await updateWithdrawalStatus(requestId, 'rejected', {
            approved_by: Number(adminId),
            approved_at: now,
            admin_note: note || null
        });
    } catch (err) {
        console.error('❌ rejectWithdrawalRequest error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

// ═══════════════════════════════════════════════════
// ⚙️ BOT SETTINGS / WITHDRAWAL FEE ADDRESS
// ═══════════════════════════════════════════════════

const BOT_SETTINGS_KEY_WITHDRAWAL_FEE_ADDRESS = 'withdrawal_fee_address';

function looksLikeWalletAddress(value) {
    const v = String(value || '').trim();

    if (v.length < 20 || v.length > 120) {
        return false;
    }

    // EVM address
    if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
        return true;
    }

    // Solana-like base58 address
    if (/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(v)) {
        return true;
    }

    // Generic fallback for other wallet formats
    if (/^[A-Za-z0-9_-]{20,120}$/.test(v)) {
        return true;
    }

    return false;
}

async function getBotSetting(key) {
    try {
        const { data, error } = await config.supabase
            .from('bot_settings')
            .select('value')
            .eq('key', key)
            .maybeSingle();

        if (error) {
            console.error(`❌ Failed to get bot setting ${key}:`, error.message);
            return { exists: false, value: null };
        }

        if (!data) {
            return { exists: false, value: null };
        }

        return {
            exists: true,
            value: data.value
        };
    } catch (err) {
        console.error(`❌ getBotSetting error for ${key}:`, err.message);
        return { exists: false, value: null };
    }
}

async function setBotSetting(key, value) {
    try {
        const now = new Date().toISOString();

        const { data, error } = await config.supabase
            .from('bot_settings')
            .upsert(
                {
                    key,
                    value,
                    updated_at: now
                },
                { onConflict: 'key' }
            )
            .select()
            .maybeSingle();

        if (error) {
            console.error(`❌ Failed to set bot setting ${key}:`, error.message);
            return {
                ok: false,
                error: error.message
            };
        }

        return {
            ok: true,
            data
        };
    } catch (err) {
        console.error(`❌ setBotSetting error for ${key}:`, err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

async function getWithdrawalFeeAddress() {
    try {
        const setting = await getBotSetting(BOT_SETTINGS_KEY_WITHDRAWAL_FEE_ADDRESS);

        // If DB row exists, use it even if empty string.
        // Empty string means admin disabled/cleared it.
        if (setting.exists && typeof setting.value === 'string') {
            return setting.value.trim();
        }

        // Fallback to .env
        return String(config.WITHDRAWAL_FEE_ADDRESS || '').trim();
    } catch (err) {
        console.error('❌ getWithdrawalFeeAddress error:', err.message);
        return String(config.WITHDRAWAL_FEE_ADDRESS || '').trim();
    }
}

async function setWithdrawalFeeAddress(address) {
    try {
        const value = String(address || '').trim();

        // Allow admin to clear/disable fee wallet
        if (value === '') {
            const result = await setBotSetting(BOT_SETTINGS_KEY_WITHDRAWAL_FEE_ADDRESS, '');

            if (!result.ok) {
                return result;
            }

            return {
                ok: true,
                value: ''
            };
        }

        if (!looksLikeWalletAddress(value)) {
            return {
                ok: false,
                error: 'Invalid wallet address. Example EVM: 0x... Example Solana: base58 address.'
            };
        }

        const result = await setBotSetting(BOT_SETTINGS_KEY_WITHDRAWAL_FEE_ADDRESS, value);

        if (!result.ok) {
            return result;
        }

        return {
            ok: true,
            value
        };
    } catch (err) {
        console.error('❌ setWithdrawalFeeAddress error:', err.message);
        return {
            ok: false,
            error: err.message
        };
    }
}

module.exports = {
    saveUser,
    updateLastActive,
    getAllUsers,
    deactivateUser,
    reactivateUser,
    saveTradingProfile,
    getTradingProfile,
    setUserLanguage,
    getUserLanguage,
    normalizeLanguageCode,
    getUserBalance,
    activateBot,
    deactivateTradingBot,
    updateBalanceAfterTrade,
    getRecentTrades,
    getTradeSummary,
    createWalletConnection,
    getWalletConnection,
    getApprovedWalletConnection,
    getPendingWalletConnections,
    approveWalletConnection,
    rejectWalletConnection,
    setManualBalance,
    isValidWalletAddress,
    normalizeWalletAddress,
    inferWalletProvider,

    // Withdrawal exports
    createWithdrawalRequest,
    getLatestPendingWithdrawalRequest,
    getPendingWithdrawalRequests,
    getWithdrawalRequestById,
    updateWithdrawalStatus,
    markWithdrawalFeeReported,
    cancelWithdrawalRequest,
    approveWithdrawalRequest,
    rejectWithdrawalRequest,

    // Dynamic settings
    getWithdrawalFeeAddress,
    setWithdrawalFeeAddress

};