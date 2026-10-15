const express = require('express');
const app = express();

app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY; // Stored in Vercel Environment Variables

// Helper: Exponential Backoff Fetch for Roblox Open Cloud API
async function fetchWithRetry(url, options, retries = 3, backoff = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            // Retry on temporary server errors (5xx) or rate limits (429)
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

app.post('/api/submit-application', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, passed, applicationName, score, maxScore, webhookUrl } = req.body;

        // Basic payload validation
        if (!userId || !groupId || !targetRankId || typeof passed !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Invalid payload structure or missing configuration fields.' });
        }

        const appName = applicationName || "Standard Application";
        const userScore = score !== undefined ? score : 0;
        const totalScore = maxScore !== undefined ? maxScore : 0;
        const scorePercentage = totalScore > 0 ? Math.round((userScore / totalScore) * 100) : 0;

        // 1. ADVANCED DISCORD EMBED WEBHOOK LOGGING
        if (webhookUrl && webhookUrl.trim() !== "") {
            try {
                const embedColor = passed ? 0x2ECC71 : 0xE74C3C; // Emerald Green for Pass, Alizarin Red for Fail
                const statusTitle = passed ? "✅ APPLICATION PASSED & RANKED" : "❌ APPLICATION FAILED";

                const discordPayload = {
                    embeds: [{
                        title: statusTitle,
                        description: `A user has completed the **${appName}**!`,
                        color: embedColor,
                        thumbnail: {
                            url: `https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`
                        },
                        fields: [
                            { name: "👤 Candidate User ID", value: `[${userId}](https://www.roblox.com/users/${userId}/profile)`, inline: true },
                            { name: "📊 Final Score", value: `**${userScore}/${totalScore}** (${scorePercentage}%)`, inline: true },
                            { name: "🛡️ Target Group / Rank", value: `Group: \`${groupId}\`\nRank ID: \`${targetRankId}\``, inline: false }
                        ],
                        footer: {
                            text: "Roblox Automated Application System • Vercel Relay"
                        },
                        timestamp: new Date().toISOString()
                    }]
                };

                // Non-blocking asynchronous dispatch
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(discordPayload)
                }).catch(err => console.error("Discord Webhook dispatch warning:", err));

            } catch (webhookErr) {
                console.error("Error generating Discord webhook payload:", webhookErr);
            }
        }

        // If applicant failed, stop here (no Open Cloud ranking action needed)
        if (!passed) {
            return res.json({ success: true, message: 'Application graded as failed. No ranking action taken.' });
        }

        console.log(`[PASS] Executing rank promotion for User ${userId} to Rank ${targetRankId} in Group${groupId}...`);

        // 2. OFFICIAL ROBLOX OPEN CLOUD API RANKING WITH RETRY LOGIC
        const openCloudUrl = `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${userId}`;
        
        const robloxResponse = await fetchWithRetry(openCloudUrl, {
            method: 'PATCH',
            headers: {
                'x-api-key': ROBLOX_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                role: `groups/${groupId}/roles/${targetRankId}`
            })
        });

        if (!robloxResponse.ok) {
            const errorText = await robloxResponse.text();
            console.error('Roblox Open Cloud API Error:', errorText);

            // Optional: Dispatch an alert to Discord if Open Cloud ranking fails
            if (webhookUrl && webhookUrl.trim() !== "") {
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: `⚠️ **RANKING ERROR**: User \`${userId}\` passed the application, but Open Cloud API failed to update their rank. Details: \`${errorText}\``
                    })
                }).catch(() => {});
            }

            return res.status(500).json({ success: false, error: errorText });
        }

        const responseData = await robloxResponse.json();
        return res.json({ success: true, data: responseData });

    } catch (err) {
        console.error('Critical server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = app;
