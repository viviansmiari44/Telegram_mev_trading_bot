// config.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// 🔒 Validate Encryption Key on Startup
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64 || !/^[0-9a-fA-F]+$/.test(process.env.ENCRYPTION_KEY)) {
    console.error('\n❌ CRITICAL: ENCRYPTION_KEY in .env is invalid!');
    console.error('It must be exactly 64 hex characters (32 bytes) for AES-256.');
    console.error('Generate one by running this in your terminal:');
    console.error('node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    process.exit(1); // Stop the bot from starting
}

// Create Supabase client with service role (bypasses RLS)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = {
    // Telegram
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    WELCOME_VIDEO: process.env.WELCOME_VIDEO_ID,
    FOLLOWUP_VIDEO: process.env.FOLLOWUP_VIDEO_ID,
    ACTIVATE_IMAGE: process.env.ACTIVATE_IMAGE_ID,
    AIRDROP_REMINDER_IMAGE: process.env.AIRDROP_REMINDER_IMAGE_ID,
    ATOMIC_EXECUTION_VIDEO: process.env.ATOMIC_EXECUTION_VIDEO_ID, // ← ADD THIS
    HONEYPOT_FILTER_VIDEO: process.env.HONEYPOT_FILTER_VIDEO_ID,

    RPC_INFRASTRUCTURE_VIDEO: process.env.RPC_INFRASTRUCTURE_VIDEO_ID,
    DEX_SCANNER_VIDEO: process.env.DEX_SCANNER_VIDEO_ID,
    CROSS_CHAIN_VIDEO: process.env.CROSS_CHAIN_VIDEO_ID,
    ENGINE_ACTIVATION_IMAGE: process.env.ENGINE_ACTIVATION_IMAGE_ID,

    // Random scheduler settings (in hours)
    RANDOM_MIN_HOURS: 2,
    RANDOM_MAX_HOURS: 6,


    // RANDOM_MIN_HOURS: 0.003,  // ~10 seconds (was 2)
    // RANDOM_MAX_HOURS: 0.005,  // ~18 seconds (was 6)

    // NEW: Admin & DB config
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_TELEGRAM_IDS: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number),
    ADMIN_DASHBOARD_PASSWORD: process.env.ADMIN_DASHBOARD_PASSWORD,

    supabase,

    // Branding
    BOT_NAME: 'Flash Extract',
    MIN_TRADE_CAPITAL_USD: 200,
    WEBSITE: 'https://flash-extract.netlify.app',
    // DOCS_URL: 'https://mev.cryptosafe.network/docs',
    CHANNEL_URL: 'https://t.me/crypto_arbitrage_trading_bots1',

    // Stats (fake for marketing, update periodically)
    STATS: {
        landRate: '91.2%',
        avgLatency: '51ms',
        chains: 5,
        volume24h: '$4.2M',
        activeUsers: 12847
    },

    // Supported chains
    CHAINS: {
        ethereum: { name: 'Ethereum', symbol: 'ETH', explorer: 'https://etherscan.io' },
        base: { name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
        bsc: { name: 'BNB Chain', symbol: 'BNB', explorer: 'https://bscscan.com' },
        arbitrum: { name: 'Arbitrum', symbol: 'ETH', explorer: 'https://arbiscan.io' },
        solana: { name: 'Solana', symbol: 'SOL', explorer: 'https://solscan.io' },
        polygon: { name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.io' }
    },

    // Encryption
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, // 32-byte hex key

    // Add this to your config.js exports
    RPC: {
        ethereum: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
        bsc: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
        polygon: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
        arbitrum: process.env.ARB_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        base: process.env.BASE_RPC_URL || 'https://mainnet.base.org'
    },

    // Fallback public RPCs (if primary fails)
    RPC_FALLBACKS: {
        ethereum: [
            'https://eth.llamarpc.com',
            'https://ethereum.publicnode.com',
            'https://rpc.ankr.com/eth'
        ],
        bsc: [
            'https://bsc-dataseed.binance.org/',
            'https://bsc-dataseed1.defibit.io',
            'https://bsc-dataseed1.ninicoin.io'
        ],
        polygon: [
            'https://polygon-rpc.com',
            'https://rpc-mainnet.matic.quiknode.pro',
            'https://polygon-bor.publicnode.com'
        ],
        arbitrum: [
            'https://arb1.arbitrum.io/rpc',
            'https://arbitrum-one.publicnode.com',
            'https://rpc.ankr.com/arbitrum'
        ],
        base: [
            'https://mainnet.base.org',
            'https://base.publicnode.com',
            'https://base.llamarpc.com'
        ]
    }
};