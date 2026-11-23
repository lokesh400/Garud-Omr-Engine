const mongoose = require('mongoose');
const { MongoStore } = require('connect-mongo');
const User = require('../models/User');

// Setup mongoose connection & MongoDB-backed session store
const mongoConnectPromise = mongoose.connect(process.env.MONGO_URL);
const sessionStore = MongoStore.create({
    clientPromise: mongoConnectPromise.then(m => m.connection.getClient()),
    collectionName: 'sessions',
    ttl: 7 * 24 * 60 * 60
});

// Seed default admin account when no admins exist yet (only if configured in environment)
async function ensureDefaultAdmin() {
    try {
        const adminCount = await User.countDocuments({ role: 'admin' });
        if (adminCount === 0) {
            const adminUsername = process.env.ADMIN_USERNAME ? process.env.ADMIN_USERNAME.trim().toLowerCase() : '';
            const adminPassword = process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.trim() : '';
            const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.trim().toLowerCase() : '';

            if (!adminUsername || !adminPassword) {
                console.log('[Auth] No admin accounts exist in database, and ADMIN_USERNAME / ADMIN_PASSWORD are not set in environment. Skipping admin creation.');
                return;
            }

            const existing = await User.findOne({ username: adminUsername });
            if (existing) {
                existing.role = 'admin';
                if (!existing.email && adminEmail) existing.email = adminEmail;
                await existing.setPassword(adminPassword);
                await existing.save();
                console.log(`[Auth] Configured admin account "${adminUsername}" from environment variables.`);
            } else {
                await User.register(
                    new User({
                        username: adminUsername,
                        fullName: 'Administrator',
                        role: 'admin',
                        rollnumber: '',
                        email: adminEmail || undefined
                    }),
                    adminPassword
                );
                console.log(`[Auth] Created admin account "${adminUsername}" from environment variables.`);
            }
        }
    } catch (err) {
        console.error('[Auth] Error setting up admin from environment:', err.message);
    }
}

// Built-in 10-Second Keep-Alive Self-Ping
function startSelfPing(port) {
    const PING_INTERVAL_MS = 10000; // 10 seconds
    const targetUrl = process.env.PING_URL ||
        (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/ping` : `http://127.0.0.1:${port}/ping`);

    console.log(`[Ping] Built-in keep-alive self-ping active (every 10s -> ${targetUrl})`);

    let pingCount = 0;
    const interval = setInterval(async () => {
        try {
            const res = await fetch(targetUrl, {
                headers: { 'User-Agent': 'OMR-Checker-Self-Ping/1.0' },
                signal: AbortSignal.timeout(5000)
            });
            pingCount++;
            if (pingCount === 1 || pingCount % 6 === 0 || process.env.VERBOSE_PING === 'true') {
                console.log(`[Ping] Heartbeat #${pingCount} OK (${res.status}) - ${new Date().toLocaleTimeString()}`);
            }
        } catch (err) {
            if (targetUrl !== `http://127.0.0.1:${port}/ping`) {
                try {
                    await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(3000) });
                } catch (e) { }
            }
            console.warn(`[Ping] Keep-alive attempt warning: ${err.message}`);
        }
    }, PING_INTERVAL_MS);

    return interval;
}

module.exports = {
    mongoConnectPromise,
    sessionStore,
    ensureDefaultAdmin,
    startSelfPing
};
