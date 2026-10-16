'use strict';

const crypto = require('crypto');
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ─── Configuration (Vercel environment variables) ───────────────────────────
const ROBLOX_API_KEY  = process.env.ROBLOX_API_KEY;               // Open Cloud key, group:write scope
const BACKEND_SECRET  = process.env.BACKEND_SECRET;               // shared with the Roblox server
const DEFAULT_WEBHOOK = process.env.DISCORD_APPLICATION_WEBHOOK || '';

const DISCORD_PREFIX  = 'https://discord.com/api/webhooks/';
const ID_PATTERN      = /^\d{1,20}$/;
const ROBLOX_TIMEOUT  = 10000;
const ROBLOX_BASE     = 'https://apis.roblox.com/cloud/v2';

// ─── Helpers ────────────────────────────────────────────────────────────────
function fail(res, status, message, extra = {}) {
    return res.status(status).json({ success: false, message, ...extra });
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isId(value) {
    return ID_PATTERN.test(String(value ?? ''));
}

function robloxFetch(url, options = {}) {
    return fetch(url, {
        ...options,
        headers: { 'x-api-key': ROBLOX_API_KEY, ...(options.headers || {}) },
        signal: AbortSignal.timeout(ROBLOX_TIMEOUT),
    });
}

async function readBody(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

// Finds the user's membership in the group. Open Cloud membership IDs are not
// the user ID, so we look the membership up first and use its `path`.
async function findMembership(groupId, userId) {
    const filter = encodeURIComponent(`user == 'users/${userId}'`);
    const response = await robloxFetch(`${ROBLOX_BASE}/groups/${groupId}/memberships?filter=${filter}`);
    if (!response.ok) {
        throw new Error(`Membership lookup failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json();
    return (data.groupMemberships && data.groupMemberships[0]) || null;
}

async function setRole(membership, targetRole) {
    const response = await robloxFetch(`${ROBLOX_BASE}/${membership.path}?updateMask=role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: targetRole }),
    });
    if (!response.ok) {
        throw new Error(`Role update failed (${response.status}): ${await response.text()}`);
    }
    return readBody(response);
}

async function notifyDiscord(webhook, { userId, groupId, targetRankId, applicationName }) {
    try {
        const response = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: '🎉 Application Passed & Ranked!',
                    color: 65280,
                    fields: [
                        { name: 'Application', value: String(applicationName || 'Unknown'), inline: true },
                        { name: 'User ID', value: String(userId), inline: true },
                        { name: 'Group ID', value: String(groupId), inline: true },
                        { name: 'Assigned Rank ID', value: String(targetRankId), inline: true },
                    ],
                    timestamp: new Date().toISOString(),
                }],
            }),
            signal: AbortSignal.timeout(ROBLOX_TIMEOUT),
        });
        if (!response.ok) {
            console.error(`[ApplicationCenter] Discord webhook returned ${response.status}`);
        }
    } catch (error) {
        // A failed notification must never fail the ranking itself.
        console.error('[ApplicationCenter] Discord webhook failed:', error.message);
    }
}

// ─── Submission handler ─────────────────────────────────────────────────────
async function handleSubmission(req, res) {
    if (!BACKEND_SECRET || !ROBLOX_API_KEY) {
        console.error('CRITICAL: BACKEND_SECRET or ROBLOX_API_KEY is not configured.');
        return fail(res, 500, 'Server configuration error.');
    }

    // 1. Authenticate: only the Roblox game server knows the secret.
    const provided = req.get('X-Backend-Secret');
    if (!provided || !safeEqual(provided, BACKEND_SECRET)) {
        return fail(res, 401, 'Unauthorized.');
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { userId, groupId, targetRankId, applicationName, passed, webhookUrl } = body;

    // 2. Validate input.
    if (passed !== true) {
        return fail(res, 400, 'Only passing submissions can be ranked.');
    }
    if (!isId(userId) || !isId(groupId) || !isId(targetRankId)) {
        return fail(res, 400, 'userId, groupId, and targetRankId must be numeric IDs.');
    }

    const targetRole = `groups/${groupId}/roles/${targetRankId}`;
    const webhook = typeof webhookUrl === 'string' && webhookUrl.startsWith(DISCORD_PREFIX)
        ? webhookUrl
        : DEFAULT_WEBHOOK;

    try {
        // 3. Look up the membership. Missing membership means the user never joined the group.
        const membership = await findMembership(groupId, userId);
        if (!membership || !membership.path) {
            return fail(res, 404, 'User is not a member of this group.');
        }

        // 4. Idempotent: if the rank is already set (for example, a retry after a
        //    lost response), report success and skip the update and the webhook.
        if (membership.role === targetRole) {
            console.log(`[ApplicationCenter] User ${userId} already has ${targetRole}; nothing to do.`);
            return res.status(200).json({ success: true, alreadyRanked: true, message: 'User already has this rank.' });
        }

        console.log(`[ApplicationCenter] Ranking user ${userId} in group ${groupId} to ${targetRole}`);
        await setRole(membership, targetRole);

        // 5. Notify only when a rank actually changed.
        if (webhook) {
            await notifyDiscord(webhook, { userId, groupId, targetRankId, applicationName });
        }

        return res.status(200).json({ success: true, alreadyRanked: false, message: 'Rank updated.' });
    } catch (error) {
        console.error('[ApplicationCenter] Ranking failed:', error.message);
        return fail(res, 502, 'Failed to update rank via Roblox API.');
    }
}

// ─── Routes ─────────────────────────────────────────────────────────────────
// Accepts the rewritten path (/api/index) and the public path (/submit-application).
const ROUTES = ['/', '/api/index', '/submit-application'];

app.post(ROUTES, (req, res) => {
    handleSubmission(req, res).catch((error) => {
        console.error('[ApplicationCenter] Unhandled error:', error);
        fail(res, 500, 'Internal server error.');
    });
});

app.get(ROUTES, (req, res) => {
    res.status(200).json({ status: 'Application Center API is online.' });
});

// Malformed JSON, oversized bodies, and unknown methods return JSON instead of HTML.
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'Malformed JSON.');
    if (err && err.type === 'entity.too.large') return fail(res, 413, 'Payload too large.');
    return fail(res, 500, 'Internal server error.');
});

app.use((req, res) => fail(res, 404, 'Not found.'));

module.exports = app;
