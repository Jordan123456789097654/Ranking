const express = require('express');
const app = express();

app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY; // Managed via Vercel Environment Variables

app.post('/api/submit-application', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, passed, applicationName, score, maxScore, webhookUrl } = req.body;

        // Basic payload validation
        if (!userId || !groupId || !targetRankId || typeof passed !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Invalid payload structure or missing configuration fields.' });
        }

        // 1. DISCORD WEBHOOK NOTIFICATION (Sent if webhookUrl is provided from config)
        if (webhookUrl && webhookUrl !== "") {
            try {
                const embedColor = passed ? 3066993 : 15158332; // Green for pass, Red for fail
                const statusText = passed ? "PASSED & RANKED UP" : "FAILED / COOLDOWN";

                const discordPayload = {
                    embeds: [{
                        title: `📋 Application Submission: ${applicationName || "Standard App"}`,
                        color: embedColor,
                        fields: [
                            { name: "User ID", value: `\`${userId}\``, inline: true },
                            { name: "Status", value: `**${statusText}**`, inline: true },
                            { name: "Score", value: `${score} / ${maxScore}`, inline: true }
                        ],
                        timestamp: new Date().toISOString()
                    }]
                };

                // Send non-blocking request to Discord webhook
                fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(discordPayload)
                }).catch(err => console.error("Discord Webhook dispatch failed:", err));

            } catch (webhookErr) {
                console.error("Error formatting Discord webhook:", webhookErr);
            }
        }

        // If the user failed the application, do not rank them up
        if (!passed) {
            return res.json({ success: true, message: 'Application graded as failed. No ranking action taken.' });
        }

        console.log(`Promoting user ${userId} to rank role ID ${targetRankId} in group ${groupId}...`);

        // 2. OFFICIAL ROBLOX OPEN CLOUD API RANKING
        const openCloudUrl = `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${userId}`;
        
        const robloxResponse = await fetch(openCloudUrl, {
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
            return res.status(500).json({ success: false, error: errorText });
        }

        const responseData = await robloxResponse.json();
        return res.json({ success: true, data: responseData });

    } catch (err) {
        console.error('Server error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Required for Vercel serverless execution
module.exports = app;
