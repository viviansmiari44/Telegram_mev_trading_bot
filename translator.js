// translator.js

const crypto = require('crypto');

const DEBUG_TRANSLATOR = process.env.DEBUG_TRANSLATOR === '1';

function dlog(...args) {
    if (DEBUG_TRANSLATOR) {
        console.log('[TRANSLATOR]', ...args);
    }
}

// Node 18+ has global fetch.
if (typeof fetch !== 'function') {
    console.error('❌ Node global fetch is unavailable. Please upgrade to Node.js 18 or newer.');
}

// Load google-translate-api-x
let googleTranslate = null;

try {
    const mod = require('google-translate-api-x');

    googleTranslate =
        typeof mod === 'function'
            ? mod
            : (mod && (mod.default || mod.translate)) || null;

    if (typeof googleTranslate !== 'function') {
        console.error('❌ google-translate-api-x loaded, but translate function is missing.');
    } else {
        dlog('google-translate-api-x loaded successfully.');
    }
} catch (err) {
    console.error('❌ Failed to load google-translate-api-x:', err.message);
    console.error('Run: npm install google-translate-api-x');
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FAIL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 10000;

const cache = new Map();

// Some Google Translate language aliases.
const LANGUAGE_ALIASES = {
    zh: 'zh-CN',
    'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW',
    he: 'iw',
    yi: 'ji'
};

// Private Unicode characters used to protect Markdown syntax.
const P = {
    ASTERISK: '\uE000',
    UNDERSCORE: '\uE001',
    BACKTICK: '\uE002',
    LBRACKET: '\uE003',
    RBRACKET: '\uE004',
    LPAREN: '\uE005',
    RPAREN: '\uE006',
    SLASH: '\uE007',

    CODE_START: '\uE010',
    CODE_END: '\uE011',

    URL_START: '\uE012',
    URL_END: '\uE013',

    CMD_START: '\uE014',
    CMD_END: '\uE015',

    FENCE_START: '\uE016',
    FENCE_END: '\uE017',

    RAW_URL_START: '\uE018',
    RAW_URL_END: '\uE019'
};

const CHAR_MAP = {
    '*': P.ASTERISK,
    '_': P.UNDERSCORE,
    '`': P.BACKTICK,
    '[': P.LBRACKET,
    ']': P.RBRACKET,
    '(': P.LPAREN,
    ')': P.RPAREN,
    '/': P.SLASH
};

const REVERSE_CHAR_MAP = Object.fromEntries(
    Object.entries(CHAR_MAP).map(([original, token]) => [token, original])
);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeLanguage(code) {
    if (!code) return 'en';
    return String(code).split('-')[0].toLowerCase();
}

function getApiLanguage(lang) {
    const normalized = normalizeLanguage(lang);
    return LANGUAGE_ALIASES[normalized] || normalized;
}

function cacheKey(text, lang) {
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    return `${lang}:${hash}`;
}

function getCached(key) {
    const item = cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expires) {
        cache.delete(key);
        return null;
    }

    return item;
}

function setCache(key, text, ttl = CACHE_TTL_MS) {
    if (cache.size >= MAX_CACHE_SIZE) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
    }

    cache.set(key, {
        text,
        expires: Date.now() + ttl
    });
}

function protectMarkdown(text) {
    const store = {
        fences: [],
        codes: [],
        mdUrls: [],
        rawUrls: [],
        cmds: []
    };

    let out = String(text || '');

    // Protect fenced code blocks: ```...```
    out = out.replace(/```([\s\S]*?)```/g, (match, content) => {
        const index = store.fences.push(content) - 1;
        return `${P.FENCE_START}${index}${P.FENCE_END}`;
    });

    // Protect inline code: `...`
    out = out.replace(/`([^`]+)`/g, (match, content) => {
        const index = store.codes.push(content) - 1;
        return `${P.CODE_START}${index}${P.CODE_END}`;
    });

    // Protect Markdown link URLs: [label](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
        const index = store.mdUrls.push(url) - 1;
        return `[${label}](${P.URL_START}${index}${P.URL_END})`;
    });

    // Protect bare URLs
    out = out.replace(/https?:\/\/[^\s<>"')\]]+/g, (url) => {
        const index = store.rawUrls.push(url) - 1;
        return `${P.RAW_URL_START}${index}${P.RAW_URL_END}`;
    });

    // Protect bot commands: /start, /docs, /admin_decrypt
    out = out.replace(
        /(^|\s)(\/[A-Za-z][A-Za-z0-9_]*(?:@[A-Za-z0-9_]+)?)/g,
        (match, space, cmd) => {
            const index = store.cmds.push(cmd) - 1;
            return `${space}${P.CMD_START}${index}${P.CMD_END}`;
        }
    );

    // Protect remaining Markdown punctuation
    out = out
        .split('')
        .map(ch => CHAR_MAP[ch] || ch)
        .join('');

    function restore(translated) {
        let result = String(translated || '');

        // Restore fenced code blocks
        result = result.replace(
            new RegExp(`${P.FENCE_START}(\\d+)${P.FENCE_END}`, 'g'),
            (match, index) => `\`\`\`${store.fences[Number(index)] || ''}\`\`\``
        );

        // Restore inline code
        result = result.replace(
            new RegExp(`${P.CODE_START}(\\d+)${P.CODE_END}`, 'g'),
            (match, index) => `\`${store.codes[Number(index)] || ''}\``
        );

        // Restore Markdown link URLs
        result = result.replace(
            new RegExp(`${P.URL_START}(\\d+)${P.URL_END}`, 'g'),
            (match, index) => store.mdUrls[Number(index)] || ''
        );

        // Restore bare URLs
        result = result.replace(
            new RegExp(`${P.RAW_URL_START}(\\d+)${P.RAW_URL_END}`, 'g'),
            (match, index) => store.rawUrls[Number(index)] || ''
        );

        // Restore bot commands
        result = result.replace(
            new RegExp(`${P.CMD_START}(\\d+)${P.CMD_END}`, 'g'),
            (match, index) => store.cmds[Number(index)] || ''
        );

        // Restore Markdown punctuation
        result = result
            .split('')
            .map(ch => REVERSE_CHAR_MAP[ch] || ch)
            .join('');

        return result;
    }

    return {
        text: out,
        restore
    };
}

function chunkText(text, maxLength = 4500) {
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let current = '';

    const lines = text.split('\n');

    for (const line of lines) {
        const candidate = current ? `${current}\n${line}` : line;

        if (candidate.length <= maxLength) {
            current = candidate;
        } else {
            if (current) chunks.push(current);

            if (line.length <= maxLength) {
                current = line;
            } else {
                for (let i = 0; i < line.length; i += maxLength) {
                    chunks.push(line.slice(i, i + maxLength));
                }
                current = '';
            }
        }
    }

    if (current) chunks.push(current);

    return chunks;
}

function splitForShortApi(text, maxLength = 450) {
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let current = '';

    const parts = text.split(/(\n+)/);

    for (const part of parts) {
        const candidate = current + part;

        if (candidate.length <= maxLength) {
            current = candidate;
            continue;
        }

        if (current) {
            chunks.push(current);
            current = '';
        }

        if (part.length <= maxLength) {
            current = part;
        } else {
            for (let i = 0; i < part.length; i += maxLength) {
                chunks.push(part.slice(i, i + maxLength));
            }
        }
    }

    if (current) chunks.push(current);

    return chunks;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        return response;
    } finally {
        clearTimeout(timeout);
    }
}

function logProviderError(providerName, err) {
    const message = err?.message || String(err);
    const cause = err?.cause;
    const causeCode = cause?.code ? ` code=${cause.code}` : '';
    const causeMessage = cause?.message ? ` cause=${cause.message}` : '';

    console.error(`❌ ${providerName} translation failed:${message}${causeCode}${causeMessage}`);
}

async function translateViaGoogle(text, lang) {
    if (typeof googleTranslate !== 'function') {
        throw new Error('google-translate-api-x is not available.');
    }

    const apiLang = getApiLanguage(lang);

    dlog(`Trying Google Translate -> ${apiLang}, length=${text.length}`);

    const response = await googleTranslate(text, {
        from: 'auto',
        to: apiLang
    });

    const translated =
        typeof response === 'string'
            ? response
            : response && typeof response.text === 'string'
                ? response.text
                : null;

    if (!translated || !translated.trim()) {
        throw new Error('Google Translate returned an empty response.');
    }

    return translated;
}

async function translateViaMyMemory(text, lang) {
    const apiLang = getApiLanguage(lang);
    const chunks = splitForShortApi(text, 450);
    const translatedChunks = [];

    dlog(`Trying MyMemory Translate -> ${apiLang}, chunks=${chunks.length}`);

    for (const chunk of chunks) {
        const url =
            'https://api.mymemory.translated.net/get?q=' +
            encodeURIComponent(chunk) +
            '&langpair=' +
            encodeURIComponent('en') +
            '|' +
            encodeURIComponent(apiLang);

        const response = await fetchWithTimeout(url, {}, 12000);

        if (!response.ok) {
            throw new Error(`MyMemory HTTP error ${response.status}`);
        }

        const data = await response.json();

        const translated = data?.responseData?.translatedText;

        if (
            !translated ||
            typeof translated !== 'string' ||
            translated.includes('MYMEMORY WARNING') ||
            translated.includes('INVALID SOURCE/TARGET LANGUAGE')
        ) {
            throw new Error(`MyMemory returned invalid translation: ${String(translated).slice(0, 120)}`);
        }

        translatedChunks.push(translated);
    }

    return translatedChunks.join('');
}

async function translateViaLibreTranslate(text, lang) {
    const baseUrl = process.env.LIBRETRANSLATE_URL;
    const apiKey = process.env.LIBRETRANSLATE_API_KEY;

    if (!baseUrl) {
        return null;
    }

    const apiLang = getApiLanguage(lang);
    const chunks = splitForShortApi(text, 1000);
    const translatedChunks = [];

    dlog(`Trying LibreTranslate -> ${apiLang}, chunks=${chunks.length}`);

    for (const chunk of chunks) {
        const response = await fetchWithTimeout(
            `${baseUrl.replace(/\/$/, '')}/translate`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify({
                    q: chunk,
                    source: 'en',
                    target: apiLang,
                    format: 'text'
                })
            },
            15000
        );

        if (!response.ok) {
            throw new Error(`LibreTranslate HTTP error ${response.status}`);
        }

        const data = await response.json();

        const translated = data?.translatedText;

        if (!translated || typeof translated !== 'string') {
            throw new Error('LibreTranslate returned an empty response.');
        }

        translatedChunks.push(translated);
    }

    return translatedChunks.join('');
}

async function translateChunk(text, lang) {
    const providers = [
        { name: 'Google', fn: translateViaGoogle },
        { name: 'MyMemory', fn: translateViaMyMemory },
        { name: 'LibreTranslate', fn: translateViaLibreTranslate }
    ];

    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        for (const provider of providers) {
            try {
                const result = await provider.fn(text, lang);

                if (result && String(result).trim()) {
                    dlog(`${provider.name} translated successfully on attempt ${attempt}.`);
                    return result;
                }
            } catch (err) {
                lastError = err;
                logProviderError(`${provider.name} attempt ${attempt}`, err);
            }

            await sleep(400 * attempt);
        }
    }

    throw lastError || new Error('All translation providers failed.');
}

async function translateText(text, lang) {
    if (!text) return text;

    const normalizedLang = normalizeLanguage(lang);

    dlog(`translateText called: lang=${normalizedLang}, textLength=${String(text).length}`);

    if (!normalizedLang || normalizedLang === 'en') {
        dlog('Skipping translation because language is English.');
        return text;
    }

    const original = String(text);
    const key = cacheKey(original, normalizedLang);

    const cached = getCached(key);
    if (cached) {
        dlog('Using cached translation.');
        return cached.text;
    }

    try {
        const chunks = chunkText(original, 4500);
        const translatedChunks = [];

        for (const chunk of chunks) {
            const protectedChunk = protectMarkdown(chunk);
            const translatedProtected = await translateChunk(protectedChunk.text, normalizedLang);
            const restored = protectedChunk.restore(translatedProtected);
            translatedChunks.push(restored);
        }

        const finalText = translatedChunks.join('');

        setCache(key, finalText, CACHE_TTL_MS);

        dlog('Translation completed.');
        return finalText;
    } catch (err) {
        console.error('❌ Translation failed:', err.message);

        // Cache failure briefly so we do not hammer the API
        setCache(key, original, FAIL_CACHE_TTL_MS);

        return original;
    }
}

function stripTelegramMarkdown(text) {
    let s = String(text || '');

    // Remove fenced code blocks
    s = s.replace(/```[\s\S]*?```/g, ' ');

    // Remove inline code backticks
    s = s.replace(/`([^`]+)`/g, '$1');

    // Convert Markdown links [text](url) -> text
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // Remove bold markers
    s = s.replace(/\*([^*\n]+)\*/g, '$1');

    // Remove italic markers
    s = s.replace(/_([^_\n]+)_/g, '$1');

    // Clean excessive blank lines
    s = s.replace(/\n{3,}/g, '\n\n');

    return s.trim();
}

function stripCodeSegments(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
}

function stripMarkdownLinkUrls(text) {
    return String(text || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

function countUnescapedChar(str, char) {
    let count = 0;

    for (let i = 0; i < str.length; i++) {
        if (str[i] === char && (i === 0 || str[i - 1] !== '\\')) {
            count++;
        }
    }

    return count;
}

function hasBalancedTelegramMarkdown(text) {
    let s = String(text || '');

    // Remove code segments so backticks do not affect counting.
    s = stripCodeSegments(s);

    // Remove Markdown link URLs so underscores inside URLs do not break validation.
    s = stripMarkdownLinkUrls(s);

    // Basic bracket/parenthesis balance check.
    const openBrackets = (s.match(/\[/g) || []).length;
    const closeBrackets = (s.match(/\]/g) || []).length;
    const openParens = (s.match(/\(/g) || []).length;
    const closeParens = (s.match(/\)/g) || []).length;

    if (openBrackets !== closeBrackets) return false;
    if (openParens !== closeParens) return false;

    // Telegram Markdown bold/italic must be balanced per line.
    const lines = s.split('\n');

    for (const line of lines) {
        const stars = countUnescapedChar(line, '*');
        const underscores = countUnescapedChar(line, '_');

        if (stars % 2 !== 0) return false;
        if (underscores % 2 !== 0) return false;
    }

    return true;
}

async function translateMessagePayload(text, lang) {
    const original = String(text || '');

    if (!original.trim()) {
        return {
            text: original,
            parse_mode: 'Markdown'
        };
    }

    const normalizedLang = normalizeLanguage(lang);

    if (!normalizedLang || normalizedLang === 'en') {
        return {
            text: original,
            parse_mode: 'Markdown'
        };
    }

    dlog(`translateMessagePayload called: lang=${normalizedLang}, length=${original.length}`);

    // Attempt 1: translate while preserving Telegram Markdown.
    try {
        const translatedMarkdown = await translateText(original, normalizedLang);

        if (translatedMarkdown && translatedMarkdown !== original) {
            if (hasBalancedTelegramMarkdown(translatedMarkdown)) {
                dlog('Markdown translation succeeded and passed validation.');
                return {
                    text: translatedMarkdown,
                    parse_mode: 'Markdown'
                };
            }

            dlog('Translated Markdown failed validation. Falling back to plain text.');
        } else {
            dlog('Markdown translation returned original text. Trying plain fallback.');
        }
    } catch (err) {
        console.error('❌ Markdown message translation failed:', err.message);
    }

    // Attempt 2: strip Markdown and translate as plain text.
    try {
        const plain = stripTelegramMarkdown(original);
        const translatedPlain = await translateText(plain, normalizedLang);

        if (translatedPlain && translatedPlain.trim()) {
            dlog('Plain fallback translation succeeded.');
            return {
                text: translatedPlain,
                parse_mode: null
            };
        }
    } catch (err) {
        console.error('❌ Plain fallback message translation failed:', err.message);
    }

    // Final fallback: return original English Markdown.
    dlog('All message translation attempts failed. Returning English fallback.');
    return {
        text: original,
        parse_mode: 'Markdown'
    };
}

module.exports = {
    translateText,
    translateMessagePayload,
    normalizeLanguage
};