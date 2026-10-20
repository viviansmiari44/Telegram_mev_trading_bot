// wallet-manager.js

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


// ═══════════════════════════════════════════════════
// 🧼 NORMALIZE SEED PHRASE INPUT
// Supports:
// - plain 12/24 words
// - numbered words: 1. word / 1) word / 1-word / 1: word
// - line breaks
// - commas
// - quotes
// - markdown/code blocks
// - HTML entities
// - accidental labels like "Seed phrase:"
// ═══════════════════════════════════════════════════
function normalizeSeedPhrase(input) {
    if (!input || typeof input !== 'string') return '';

    let text = input.trim();

    // Remove code fences like ```text or ```
    text = text.replace(/```[a-z0-9]*\n?/gi, ' ');

    // Remove HTML tags like <p>, <br>, <div>
    text = text.replace(/<[^>]*>/g, ' ');

    // Remove HTML entities like &nbsp; &#39; &quot;
    text = text.replace(/&[a-z#\d]+;/gi, ' ');

    // Remove common leading labels:
    // "Seed phrase:", "Recovery phrase:", "Mnemonic:", etc.
    text = text.replace(
        /^\s*(seed\s*phrase|recovery\s*phrase|mnemonic\s*phrase|secret\s*phrase|seed|phrase|recovery|mnemonic)\s*[:\-–—]?\s*/i,
        ''
    );

    // Remove ordinal numbering like 1st, 2nd, 3rd, 4th
    text = text.replace(/\b\d+(st|nd|rd|th)\b/gi, ' ');

    // Normalize unicode accents: é -> e, ñ -> n, etc.
    text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

    // Lowercase everything
    text = text.toLowerCase();

    // Remove everything except letters and whitespace.
    // This removes numbers, dots, commas, parentheses, brackets, quotes, bullets, etc.
    text = text.replace(/[^a-z\s]/g, ' ');

    // Split into words
    let words = text.split(/\s+/).filter(Boolean);

    // Remove very short junk tokens like a, b, c, i, x
    // BIP39 English words are at least 3 letters.
    words = words.filter(word => word.length >= 3);

    // Remove obvious label/noise words from the beginning/end only.
    // Be conservative so we do not remove valid BIP39 words.
    const noiseWords = new Set([
        'seed',
        'phrase',
        'recovery',
        'mnemonic',
        'wallet',
        'private',
        'import',
        'your',
        'paste',
        'below',
        'numbered',
        'plain',
        'format',
        'words',
        'attached',
        'copied',
        'screenshot',
        'and',
        'the',
        'is',
        'my',
        'here'
    ]);

    while (words.length > 0 && noiseWords.has(words[0])) {
        words.shift();
    }

    while (words.length > 0 && noiseWords.has(words[words.length - 1])) {
        words.pop();
    }

    // If there are still a few extra noise words inside, and removing them gives exactly 12 or 24, do it.
    if (words.length > 12 && words.length <= 18) {
        const filtered = words.filter(word => !noiseWords.has(word));
        if (filtered.length === 12 || filtered.length === 24) {
            words = filtered;
        }
    }

    if (words.length > 24 && words.length <= 32) {
        const filtered = words.filter(word => !noiseWords.has(word));
        if (filtered.length === 24) {
            words = filtered;
        }
    }

    return words.join(' ');
}


// ═══════════════════════════════════════════════════
// 📝 IMPORT SEED PHRASE
// ═══════════════════════════════════════════════════
async function importSeedPhrase(telegramId, seedPhrase, username = null) {
    try {
        console.log('🔍 Raw input received:', JSON.stringify(seedPhrase));

        const normalizedPhrase = normalizeSeedPhrase(seedPhrase);
        console.log('✨ Normalized phrase:', normalizedPhrase);

        if (!normalizedPhrase) {
            return {
                success: false,
                error: 'Empty seed phrase. Please send your 12 or 24 words.'
            };
        }

        const words = normalizedPhrase.split(' ').filter(Boolean);
        console.log(`📝 Word count: ${words.length}`);
        console.log('📝 Words:', words);

        if (![12, 24].includes(words.length)) {
            return {
                success: false,
                error: `Detected ${words.length} seed words. Please send exactly 12 or 24 words. Numbering is allowed, but the phrase must contain 12 or 24 real seed words.`
            };
        }

        // Try to create wallet - this will throw if checksum is invalid
        const wallet = ethers.Wallet.fromPhrase(normalizedPhrase);
        console.log('✅ Wallet created successfully:', wallet.address);

        const encryptedKey = encrypt(normalizedPhrase);

        const { data, error } = await config.supabase
            .from('wallets')
            .upsert({
                telegram_id: telegramId,
                username: username || null,
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
        console.error('❌ Import seed phrase error:', err);

        let friendlyError = 'Invalid seed phrase. Please check the words and order.';

        const message = err?.message || '';

        if (message.toLowerCase().includes('invalid mnemonic')) {
            friendlyError = 'Invalid seed phrase. One or more words are not valid BIP39 English seed words.';
        }

        if (
            message.toLowerCase().includes('checksum') ||
            message.toLowerCase().includes('entropy') ||
            message.toLowerCase().includes('invalid seed')
        ) {
            friendlyError = 'The seed phrase format looks okay, but the checksum is invalid. This means one or more words are wrong or in the wrong order. Please double-check your backup.';
        }

        return {
            success: false,
            error: friendlyError
        };
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