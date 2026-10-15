const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

app.post('/api/index', async (req, res) => {
    try {
        const { userId, username, answers, positionApplied, webhookUrl } = req.body;

        if (!userId || !answers || !positionApplied) {
            return res.status(400).json({ 
                success: false, 
                message: "Missing required application parameters." 
            });
        }

        console.log(`[ApplicationCenter] Received submission from User ${userId} (${username}) for position: ${positionApplied}`);

        // Optional: Post to Discord webhook if provided
        if (webhookUrl && webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
            // Forward data to Discord here if needed
        }

        return res.status(200).json({
            success: true,
            message: "Application submitted and logged successfully."
        });

    } catch (error) {
        console.error("[ApplicationCenter Error]:", error);
        return res.status(500).json({ 
            success: false, 
            message: "Internal server error while processing application." 
        });
    }
});

// Also allow standard GET checks so a 404 isn't thrown if visited in a browser
app.get('/api/index', (req, res) => {
    res.status(200).json({ status: "Application Center API is online." });
});

module.exports = app;
