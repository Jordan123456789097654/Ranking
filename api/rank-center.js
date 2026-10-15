const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const BACKEND_SECRET = process.env.BACKEND_SECRET; 

// In-memory fallback map (Recommendation: Swap this out for Upstash Redis in production)
const processedTransactions = new Set();

// Helper: Exponential Backoff Fetch for Roblox Open Cloud API
async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok || (response.status !== 429 && response.status < 500)) {
                return response;
            }
        } catch (err) {
            if (i === retries - 1) throw err;
        }
        await new Promise(resolve => setTimeout(resolve, backoff * Math.pow(2, i)));
    }
    return fetch(url, options);
}

app.post('/api/claim-rank', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, gamePassId, purchaseId, universeId, webhookUrl } = req.body;

        // 1. PAYLOAD VALIDATION
        if (!userId || !groupId || !targetRankId || !gamePassId || !purchaseId || !universeId) {
            return res.status(400).json({ success: false, message: 'Missing required configuration or transaction fields.' });
        }

        // 2. HMAC SIGNATURE VERIFICATION
        if (BACKEND_SECRET) {
            const clientSignature = req.headers['x-signature'];
            const computedSignature = crypto
                .createHmac('sha256', BACKEND_SECRET)
                .update(JSON.stringify(req.body))
                .digest('hex');

            if (!clientSignature || clientSignature !== computedSignature) {
                console.warn(`[SECURITY] Unauthorized signature attempt from User ${userId}`); return res.status(401).json({ success: false, message: 'Unauthorized request signature.' }); } }  // 3. IDEMPOTENCY CHECK (Prevent duplicate claims) if (processedTransactions.has(purchaseId)) { return res.status(400).json({ success: false, message: 'This purchase receipt has already been claimed.' }); }  // 4. SERVER-SIDE GAMEPASS OWNERSHIP VERIFICATION const ownershipUrl = `https://apis.roblox.com/cloud/v2/universes/${universeId}/users/${userId}/game-passes/${gamePassId}`;
        const ownershipResponse = await fetchWithRetry(ownershipUrl, {
            method: 'GET',
            headers: { 'x-api-key': ROBLOX_API_KEY }
        });

        if (!ownershipResponse.ok) {
            return res.status(403).json({ success: false, message: 'Failed to verify gamepass ownership with Roblox API.' });
        }

        const ownershipData = await ownershipResponse.json();
        if (!ownershipData.owned) {
            return res.status(403).json({ success: false, message: 'Anti-Exploit: User does not own this gamepass!' });
        }

        // Lock transaction to prevent replay attacks
        processedTransactions.add(purchaseId);

        console.log(`[RANK CENTER] Verified ownership for User ${userId}. Promoting to Rank ${targetRankId} in Group${groupId}...`);

        // 5. EXECUTE GROUP RANK UPDATE WITH RETRY LOGIC
        const openCloudUrl = `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${userId}`;
        const rankResponse = await fetchWithRetry(openCloudUrl, {
            method: 'PATCH',
            headers: {
                'x-api-key': ROBLOX_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                role: `groups/${groupId}/roles/${targetRankId}`
            })
        });

        if (!rankResponse.ok) {
            const errorText = await rankResponse.text();
            console.error('Roblox Open Cloud Ranking Error:', errorText);

            if (webhookUrl && webhookUrl.trim() !== "") {
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: `⚠️ **RANK CENTER ERROR**: User \`${userId}\` owns gamepass \`${gamePassId}\`, but Open Cloud failed to rank them. Error: \`${errorText}\``
                    })
                }).catch(() => {});
            }

            return res.status(500).json({ success: false, error: errorText });
        }

        // 6. RICH DISCORD AUDIT EMBED LOG
        if (webhookUrl && webhookUrl.trim() !== "") {
            try {
                const discordPayload = {
                    embeds: [{
                        title: "⭐ Gamepass Rank Claimed Successfully",
                        color: 0xF1C40F,
                        thumbnail: {
                            url: `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`
                        },
                        fields: [
                            { name: "👤 User ID", value: `[${userId}](https://www.roblox.com/users/${userId}/profile)`, inline: true },
                            { name: "🎟️ GamePass ID", value: `\`${gamePassId}\``, inline: true },
                            { name: "🛡️ Group & Target Rank", value: `Group: \`${groupId}\`\nRank ID: \`${targetRankId}\``, inline: false }
                        ],
                        footer: { text: "Rank Center Automated System • Vercel" },
                        timestamp: new Date().toISOString()
                    }]
                };

                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(discordPayload)
                }).catch(err => console.error("Webhook dispatch warning:", err));
            } catch (err) {
                console.error("Webhook formatting error:", err);
            }
        }

        const responseData = await rankResponse.json();
        return res.json({ success: true, data: responseData });

    } catch (err) {
        console.error('Critical backend error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = app;
