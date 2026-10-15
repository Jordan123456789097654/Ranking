const express = require('express');
const app = express();

app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY; // Managed via Vercel Environment Variables

app.post('/api/submit-application', async (req, res) => {
    try {
        const { userId, groupId, targetRankId, passed } = req.body;

        // Basic payload validation
        if (!userId || !groupId || !targetRankId || typeof passed !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Invalid payload structure or missing configuration fields.' });
        }

        // If the user failed the application, do not rank them up
        if (!passed) {
            return res.json({ success: true, message: 'Application graded as failed. No ranking action taken.' });
        }

        console.log(`Promoting user ${userId} to rank role ID ${targetRankId} in group ${groupId}...`);

        // Official Roblox Open Cloud v2 Endpoint for group membership role updates
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
