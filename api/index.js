'use strict';

const crypto = require('crypto');
const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ─── Configuration (Vercel environment variables) ───────────────────────────
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const BACKEND_SECRET = process.env.BACKEND_SECRET;
const PASS_WEBHOOK   = process.env.DISCORD_APPLICATION_WEBHOOK || ''; // public pass announcements
const STAFF_WEBHOOK  = process.env.DISCORD_STAFF_WEBHOOK || '';       // failed/speed attempts + outages
const KV_URL         = process.env.KV_REST_API_URL || '';             // optional (Vercel KV / Upstash)
const KV_TOKEN       = process.env.KV_REST_API_TOKEN || '';
const RATE_LIMIT     = Number(process.env.RATE_LIMIT_PER_MINUTE) || 20;

const DISCORD_PREFIX = 'https://discord.com/api/webhooks/';
const ID_PATTERN     = /^\d{1,20}$/;
const ROBLOX_BASE    = 'https://apis.roblox.com/cloud/v2';
const ROBLOX_TIMEOUT = 10000;
const LOG_CAP        = 5000;
const RESULTS        = new Set(['passed', 'failed', 'speed']);
const ROUTES         = ['/', '/api/index', '/submit-application'];
const kvEnabled      = Boolean(KV_URL && KV_TOKEN);

// ─── Logging (one JSON line per event, filterable in Vercel logs) ───────────
function log(level, requestId, message, extra = {}) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, requestId, message, ...extra });
    if (level === 'error') console.error(line);
    else console.log(line);
}

// ─── Optional KV store (Upstash REST). Failures never block a ranking. ──────
async function kv(...command) {
    if (!kvEnabled) return null;
    const res = await fetch(KV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(4000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `KV HTTP ${res.status}`);
    return data.result;
}

async function kvSafe(...command) {
    try {
        return await kv(...command);
    } catch (error) {
        log('warn', null, 'KV command failed', { error: error.message });
        return null;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isId(value) {
    return ID_PATTERN.test(String(value ?? ''));
}

function staffEmbed(title, color, fields) {
    return {
        embeds: [{
            title,
            color,
            fields: fields.map(([name, value]) => ({
                name: String(name).slice(0, 256),
                value: String(value).slice(0, 1024),
                inline: true,
            })),
            timestamp: new Date().toISOString(),
        }],
    };
}

async function postWebhook(url, payload) {
    if (!url || !url.startsWith(DISCORD_PREFIX)) return;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(ROBLOX_TIMEOUT),
        });
        if (!res.ok) log('warn', null, 'Discord webhook returned non-OK', { status: res.status });
    } catch (error) {
        log('warn', null, 'Discord webhook failed', { error: error.message });
    }
}

// One outage alert per 5 minutes, so a Roblox outage doesn't flood the staff channel.
async function alertRobloxOutage(requestId, status, detail) {
    const first = await kvSafe('SET', 'alert:roblox-outage', '1', 'NX', 'EX', 300);
    if (kvEnabled && first !== 'OK') return;
    await postWebhook(STAFF_WEBHOOK, staffEmbed('⚠️ Roblox API error', 15548997, [
        ['Status', status],
        ['Request', requestId],
        ['Detail', String(detail).slice(0, 300)],
    ]));
}

// Fixed-window limit per player per minute.
async function isRateLimited(userId) {
    if (!kvEnabled) return false;
    const key = `rl:${userId}:${Math.floor(Date.now() / 60000)}`;
    const count = await kvSafe('INCR', key);
    if (typeof count !== 'number') return false;
    if (count === 1) await kvSafe('EXPIRE', key, 120);
    return count > RATE_LIMIT;
}

async function recordEvent(event) {
    if (!kvEnabled) return;
    await kvSafe('LPUSH', 'log:events', JSON.stringify({ ...event, at: Date.now() }));
    await kvSafe('LTRIM', 'log:events', 0, LOG_CAP - 1);
}

// ─── Roblox Open Cloud ──────────────────────────────────────────────────────
class RobloxError extends Error {
    constructor(status, detail) {
        super(`Roblox API ${status}: ${detail}`);
        this.status = status;
        this.detail = detail;
    }
}

async function robloxJson(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { 'x-api-key': ROBLOX_API_KEY, ...(options.headers || {}) },
        signal: AbortSignal.timeout(ROBLOX_TIMEOUT),
    });
    const text = await res.text();
    if (!res.ok) throw new RobloxError(res.status, text);
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return {};
    }
}

// The membership ID is not the user ID, so look the membership up first.
async function findMembership(groupId, userId) {
    const filter = encodeURIComponent(`user == 'users/${userId}'`);
    const data = await robloxJson(`${ROBLOX_BASE}/groups/${groupId}/memberships?filter=${filter}`);
    return (data.groupMemberships && data.groupMemberships[0]) || null;
}

// Group roles carry a numeric rank (1–255). Higher number = higher rank.
async function getRoleRank(rolePath) {
    const role = await robloxJson(`${ROBLOX_BASE}/${rolePath}`);
    if (typeof role.rank !== 'number') throw new Error('Role response had no numeric rank.');
    return role.rank;
}

async function setRole(membership, targetRole) {
    await robloxJson(`${ROBLOX_BASE}/${membership.path}?updateMask=role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: targetRole }),
    });
}

// ─── Request handling ───────────────────────────────────────────────────────
async function handleRequest(req, res, requestId) {
    const fail = (status, message) => res.status(status).json({ success: false, message, requestId });

    if (!BACKEND_SECRET || !ROBLOX_API_KEY) {
        log('error', requestId, 'BACKEND_SECRET or ROBLOX_API_KEY is not configured');
        return fail(500, 'Server configuration error.');
    }

    const provided = req.get('X-Backend-Secret');
    if (!provided || !safeEqual(provided, BACKEND_SECRET)) {
        log('warn', requestId, 'Rejected request with missing or wrong secret', { ip: req.ip });
        return fail(401, 'Unauthorized.');
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const kind = body.kind === 'attempt' ? 'attempt' : 'pass';
    const { userId, groupId, targetRankId, passed, webhookUrl } = body;
    const applicationName = String(body.applicationName || 'Unknown').slice(0, 64);

    if (!isId(userId)) return fail(400, 'userId must be a numeric ID.');

    if (await isRateLimited(userId)) {
        log('warn', requestId, 'Rate limited', { userId });
        return fail(429, 'Too many requests. Slow down.');
    }

    // ── Attempt report (failed or speed-flagged; passes also use this path) ──
    if (kind === 'attempt') {
        const { result, score, maxScore } = body;
        const validNumbers = Number.isInteger(score) && Number.isInteger(maxScore)
            && score >= 0 && maxScore >= 0 && score <= 1000 && maxScore <= 1000;
        if (!RESULTS.has(result) || !validNumbers) return fail(400, 'Invalid attempt data.');

        await recordEvent({ kind, requestId, userId, applicationName, result, score, maxScore });

        if (result !== 'passed') {
            const isSpeed = result === 'speed';
            await postWebhook(STAFF_WEBHOOK, staffEmbed(
                isSpeed ? '⚡ Speed flag' : '❌ Failed attempt',
                isSpeed ? 16750848 : 15548997,
                [['Application', applicationName], ['User ID', userId], ['Score', `${score}/${maxScore}`], ['Result', result]]
            ));
        }

        log('info', requestId, 'Attempt recorded', { userId, applicationName, result });
        return res.status(200).json({ success: true, recorded: true, requestId });
    }

    // ── Pass: rank the player ───────────────────────────────────────────────
    if (passed !== true) return fail(400, 'Only passing submissions can be ranked.');
    if (!isId(groupId) || !isId(targetRankId)) {
        return fail(400, 'groupId and targetRankId must be numeric IDs.');
    }

    const targetRole = `groups/${groupId}/roles/${targetRankId}`;
    const webhook = typeof webhookUrl === 'string' && webhookUrl.startsWith(DISCORD_PREFIX)
        ? webhookUrl
        : PASS_WEBHOOK;

    try {
        const membership = await findMembership(groupId, userId);
        if (!membership || !membership.path || !membership.role) {
            return fail(404, 'User is not a member of this group.');
        }

        if (membership.role === targetRole) {
            log('info', requestId, 'Already ranked', { userId, targetRole });
            return res.status(200).json({
                success: true, ranked: false, alreadyRanked: true,
                reason: 'already', message: 'User already has this rank.', requestId,
            });
        }

        const [currentRank, targetRank] = await Promise.all([
            getRoleRank(membership.role),
            getRoleRank(targetRole),
        ]);
        if (currentRank >= targetRank) {
            log('info', requestId, 'Skipped: current rank is equal or higher', { userId, currentRank, targetRank });
            await recordEvent({ kind, requestId, userId, applicationName, outcome: 'higher_rank' });
            return res.status(200).json({
                success: true, ranked: false, alreadyRanked: false,
                reason: 'higher_rank', message: 'User is already at or above the target rank.', requestId,
            });
        }

        await setRole(membership, targetRole);
        log('info', requestId, 'Ranked', { userId, groupId, targetRole });
        await recordEvent({ kind, requestId, userId, applicationName, outcome: 'ranked' });

        await postWebhook(webhook, staffEmbed('🎉 Application Passed & Ranked!', 65280, [
            ['Application', applicationName],
            ['User ID', userId],
            ['Group ID', groupId],
            ['Assigned Rank ID', targetRankId],
        ]));

        return res.status(200).json({
            success: true, ranked: true, alreadyRanked: false,
            reason: 'ranked', message: 'Rank updated.', requestId,
        });
    } catch (error) {
        const status = error instanceof RobloxError ? error.status : undefined;
        log('error', requestId, 'Ranking failed', { userId, groupId, robloxStatus: status, error: error.message });
        if (!status || status >= 500) {
            await alertRobloxOutage(requestId, status || 'timeout', error.message);
        }
        return fail(502, 'Failed to update rank via Roblox API.');
    }
}

// ─── Routes ─────────────────────────────────────────────────────────────────
function getRequestId(req) {
    const incoming = req.get('x-request-id');
    return incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
}

app.post(ROUTES, (req, res) => {
    const requestId = getRequestId(req);
    res.setHeader('X-Request-Id', requestId);
    handleRequest(req, res, requestId).catch((error) => {
        log('error', requestId, 'Unhandled error', { error: error.message });
        res.status(500).json({ success: false, message: 'Internal server error.', requestId });
    });
});

app.get('/health', async (req, res) => {
    const checks = {};

    try {
        // Any HTTP response below 500 means Roblox is reachable.
        const response = await fetch(`${ROBLOX_BASE}/`, { signal: AbortSignal.timeout(4000) });
        checks.roblox = response.status < 500 ? 'ok' : 'degraded';
    } catch {
        checks.roblox = 'down';
    }

    if (!kvEnabled) {
        checks.kv = 'not_configured';
    } else {
        checks.kv = (await kvSafe('PING')) === 'PONG' ? 'ok' : 'down';
    }

    const healthy = checks.roblox === 'ok';
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'healthy' : 'unhealthy', checks });
});

app.get(ROUTES, (req, res) => {
    res.status(200).json({ status: 'Application Center API is online.' });
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Malformed JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Payload too large.' });
    return res.status(500).json({ success: false, message: 'Internal server error.' });
});

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found.' }));

module.exports = app;
