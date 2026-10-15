const express = require('express');
const cors = require('cors');
const app = express();

// Enable CORS and JSON parsing so web browsers and Roblox Studio can connect smoothly
app.use(cors({ origin: '*' }));
app.use(express.json());

app.post('/api/rank-center', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, gamePassId, purchaseId, universeId, webhookUrl } = req.body;

        // Basic payload validation
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

        // TODO: Insert your Roblox Open Cloud API call here to update the user's role via the Groups API
        // Example endpoint structure: https://groups.roblox.com/v1/groups/{groupId}/users/{userId}

        // Return a successful response
        return res.status(200).json({
            success: true,
            message: "Successfully processed rank update.",
            userId: userId,
            targetRankId: targetRankId
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
