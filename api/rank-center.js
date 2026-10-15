const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

app.post('/api/rank-center', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, gamePassId, purchaseId, universeId, webhookUrl } = req.body;

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

        console.log(`[RankCenter] Processing rank change for User ${userId} in Group ${groupId} to Rank ID ${targetRankId}`);

        // --- ROBLOX OPEN CLOUD API CALL ---
        // Roblox Open Cloud uses the Groups v2 / Cloud APIs to update member roles.
        // Endpoint structure for updating a user's role in a group:
        const robloxResponse = await fetch(`https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${userId}`, {
            method: 'PATCH',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                // Open Cloud expects the role resource path or ID depending on the exact schema version
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

        return res.status(200).json({
            success: true,
            message: "Successfully updated rank in Roblox group!",
            data: robloxData
        });

    } catch (error) {
        console.error("[RankCenter Error]:", error);
        return res.status(500).json({ 
            success: false, 
            message: "Internal server error during ranking process." 
        });
    }
});

module.exports = app;
