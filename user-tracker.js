const config = require('./config');

// ═══════════════════════════════════════════════════
// 👤 SAVE USER TO DATABASE (called on /start)
// ═══════════════════════════════════════════════════
async function saveUser(telegramId, username, firstName) {
    try {
        const { error } = await config.supabase
            .from('users')
            .upsert({
                telegram_id: telegramId,
                username: username || null,
                first_name: firstName || null,
                started_at: new Date().toISOString(),
                last_active_at: new Date().toISOString(),
                random_scheduler_active: true
            }, { onConflict: 'telegram_id' });

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

module.exports = {
    saveUser,
    updateLastActive,
    getAllUsers,
    deactivateUser,
    reactivateUser
};