const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

app.post('/api/index', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, webhookUrl } = req.body;

        // Validate required ranking parameters from the application pass event
        if (!userId || !groupId || !targetRankId) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing required parameters (userId, groupId, or targetRankId)." 
            });
        }

        const apiKey = process.env.ROBLOX_API_KEY;
        if (!apiKey) {
            console.error("CRITICAL: ROBLOX_API_KEY is not defined in Vercel environment variables.");
            return res.status(500).json({ 
                success: false, 
                message: "Server configuration error: API key missing." 
            });
        }

        console.log(`[ApplicationCenter] Processing automatic rank reward for User ${userId} in Group ${groupId} to Rank ID ${targetRankId}`);

        // Execute Roblox Open Cloud API call to update member rank upon passing
        const robloxResponse = await fetch(`https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${userId}`, {
            method: 'PATCH',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                role: `groups/${groupId}/roles/${targetRankId}`
            })
        });

        if (!robloxResponse.ok) {
            const errorText = await robloxResponse.text();
            console.error("Roblox Open Cloud Error:", errorText);
            return res.status(502).json({
                success: false,
                message: "Failed to update rank via Roblox API.",
                details: errorText
            });
        }

        const robloxData = await robloxResponse.json();

        // Optional: Send a notification to a Discord webhook if provided
        const targetWebhook = webhookUrl || process.env.DISCORD_APPLICATION_WEBHOOK;
        if (targetWebhook && targetWebhook.startsWith("https://discord.com/api/webhooks/")) {
            await fetch(targetWebhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    embeds: [{
                        title: `🎉 Application Passed & Ranked!`,
                        color: 65280, // Green color
                        fields: [
                            { name: "User ID", value: String(userId), inline: true },
                            { name: "Group ID", value: String(groupId), inline: true },
                            { name: "Assigned Rank ID", value: String(targetRankId), inline: true }
                        ],
                        timestamp: new Date().toISOString()
                    }]
                })
            });
        }

        return res.status(200).json({
            success: true,
            message: "Successfully passed application and updated Roblox rank!",
            data: robloxData
        });

    } catch (error) {
        console.error("[ApplicationCenter Error]:", error);
        return res.status(500).json({ 
            success: false, 
            message: "Internal server error while processing application ranking." 
        });
    }
});

app.get('/api/index', (req, res) => {
    res.status(200).json({ status: "Application Center API is online." });
});

module.exports = app;
