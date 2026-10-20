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
    normalizeLanguageCode
};