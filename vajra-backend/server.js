require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { getDistance, isPointInPolygon } = require("geolib");
const twilio = require("twilio");

const app = express();
app.set("trust proxy", 1); // CRUCIAL for Render deployment to generate https:// links
app.use(cors());
app.use(express.json());

// Serve frontend from same directory
app.use(express.static(path.join(__dirname, 'frontend')));
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// ========================
// CONFIG
// ========================
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;         // for outgoing SOS events
const n8nIntakeWebhook = process.env.N8N_INTAKE_WEBHOOK_URL;  // for outgoing "new session" events
const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY;
const policeNumber = process.env.POLICE_PHONE_NUMBER || ""; // optional
const client = (accountSid && authToken) ? new twilio(accountSid, authToken) : null;

// ========================
// PERSISTENCE
// ========================
const DB_FILE = path.join(__dirname, "sessions.json");
const HAZARD_FILE = path.join(__dirname, "hazards.json");
let sessions = {};
let hazardZones = [];

function saveSessions() { fs.writeFileSync(DB_FILE, JSON.stringify(sessions, null, 2)); }
function saveHazardZones() { fs.writeFileSync(HAZARD_FILE, JSON.stringify(hazardZones, null, 2)); }

function loadSessions() {
    if (fs.existsSync(DB_FILE)) {
        try { sessions = JSON.parse(fs.readFileSync(DB_FILE)); }
        catch (e) { console.error("sessions load fail:", e.message); }
    }
}
function loadHazardZones() {
    if (fs.existsSync(HAZARD_FILE)) {
        try { hazardZones = JSON.parse(fs.readFileSync(HAZARD_FILE)); return; }
        catch (e) { console.error("hazards load fail:", e.message); }
    }
    hazardZones = [];
}
loadSessions();
loadHazardZones();

// ========================
// SAFETY ENGINE
// ========================

function isZoneActive(zone, hour = new Date().getHours()) {
    const { start, end } = zone.activeHours || { start: 0, end: 24 };
    return start <= end
        ? hour >= start && hour < end
        : hour >= start || hour < end;
}

function getPointRiskScore(lat, lng, hour = new Date().getHours()) {
    let maxRisk = 0;
    const point = { latitude: lat, longitude: lng };
    for (const zone of hazardZones) {
        if (!isZoneActive(zone, hour)) continue;
        try {
            if (isPointInPolygon(point, zone.polygon)) {
                maxRisk = Math.max(maxRisk, zone.riskScore || 0);
            }
        } catch (_) { }
    }
    return maxRisk;
}

/**
 * Densify a route by sampling points every ~50m along each segment.
 * This matters because Google returns sparse polylines — a 2km segment
 * with only 2 points would miss hazard zones in between.
 */
function densifyRoute(points, intervalMeters = 50) {
    if (!points || points.length < 2) return points || [];
    const dense = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const segDist = getDistance(
            { latitude: a.lat, longitude: a.lng },
            { latitude: b.lat, longitude: b.lng }
        );
        const steps = Math.max(1, Math.ceil(segDist / intervalMeters));
        for (let s = 0; s < steps; s++) {
            const t = s / steps;
            dense.push({
                lat: a.lat + (b.lat - a.lat) * t,
                lng: a.lng + (b.lng - a.lng) * t
            });
        }
    }
    dense.push(points[points.length - 1]);
    return dense;
}

/**
 * Score a route on safety + duration.
 * - safetyScore: 0–100 (100 = no hazards encountered)
 * - corridorQuality: High / Medium / Low
 * - highRiskSegments: points where riskScore >= 6
 */
function scoreRoute(routePoints, durationSeconds = null) {
    if (!routePoints || routePoints.length === 0) {
        return { score: 100, corridorQuality: "High", highRiskSegments: [], durationSeconds };
    }

    const dense = densifyRoute(routePoints, 50);
    const hour = new Date().getHours();
    let totalRisk = 0;
    let hazardHits = 0;
    const highRiskSegments = [];

    dense.forEach((pt, i) => {
        const risk = getPointRiskScore(pt.lat, pt.lng, hour);
        totalRisk += risk;
        if (risk > 0) hazardHits++;
        if (risk >= 6) highRiskSegments.push({ index: i, lat: pt.lat, lng: pt.lng, riskScore: risk });
    });

    const avgRisk = totalRisk / dense.length;
    const hazardRatio = hazardHits / dense.length; // fraction of route inside any hazard
    // Penalize both average severity AND how much of the route is exposed
    const rawScore = 100 - (avgRisk * 8) - (hazardRatio * 20);
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    const corridorQuality = score >= 80 ? "High" : score >= 55 ? "Medium" : "Low";

    return { score, corridorQuality, highRiskSegments, durationSeconds, hazardRatio: +hazardRatio.toFixed(3) };
}

// ========================
// GOOGLE MAPS INTEGRATION
// ========================

async function geocodeAddress(address) {
    if (!googleMapsKey) throw new Error("GOOGLE_MAPS_API_KEY not configured");
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${googleMapsKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== "OK" || !data.results?.length) {
        throw new Error(`Geocoding failed: ${data.status}`);
    }
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, label: data.results[0].formatted_address };
}

/**
 * Decode Google's encoded polyline to {lat, lng}[] points.
 * Standard algorithm — no external dep needed.
 */
function decodePolyline(encoded) {
    const points = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
        let b, shift = 0, result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = 0; result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
        points.push({ lat: lat * 1e-5, lng: lng * 1e-5 });
    }
    return points;
}

/**
 * Fetch multiple candidate routes from Google Directions with alternatives=true,
 * then re-rank them by our combined safety+duration score.
 *
 * This is the money feature for judges:
 * "Google returns the fastest routes; we re-rank them by safety."
 */
async function fetchSafestRoute(startLat, startLng, destLat, destLng, mode = "walking") {
    if (!googleMapsKey) {
        console.warn("GOOGLE_MAPS_API_KEY not set — using mock route");
        return {
            chosen: { points: generateMockRoute(startLat, startLng, destLat, destLng), safetyScore: scoreRoute([]) },
            alternatives: []
        };
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json`
        + `?origin=${startLat},${startLng}`
        + `&destination=${destLat},${destLng}`
        + `&mode=${mode}`
        + `&alternatives=true`
        + `&key=${googleMapsKey}`;

    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== "OK" || !data.routes?.length) {
        throw new Error(`Google Directions error: ${data.status} ${data.error_message || ""}`);
    }

    // Find max duration across candidates so we can normalize
    const durations = data.routes.map(r => r.legs.reduce((s, l) => s + l.duration.value, 0));
    const maxDur = Math.max(...durations);

    const scored = data.routes.map((route, idx) => {
        const points = decodePolyline(route.overview_polyline.points);
        const duration = durations[idx];
        const distance = route.legs.reduce((s, l) => s + l.distance.value, 0);
        const safety = scoreRoute(points, duration);

        // Normalized duration score (0-100): shorter = higher
        const durationScore = maxDur > 0 ? Math.round((1 - duration / maxDur) * 100) : 100;

        // Weighted — safety dominates
        const combinedScore = Math.round(0.7 * safety.score + 0.3 * durationScore);

        return {
            points,
            summary: route.summary,
            distance,
            duration,
            safety,
            durationScore,
            combinedScore
        };
    });

    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    const [chosen, ...alternatives] = scored;
    return { chosen, alternatives };
}

function generateMockRoute(startLat, startLng, destLat, destLng) {
    const steps = 12, route = [];
    for (let i = 0; i <= steps; i++) {
        route.push({
            lat: startLat + (destLat - startLat) * (i / steps),
            lng: startLng + (destLng - startLng) * (i / steps)
        });
    }
    return route;
}

function getDistanceToRoute(point, route) {
    if (!route || route.length === 0) return 0;
    let minDistance = Infinity;
    route.forEach(rp => {
        const d = getDistance(
            { latitude: point.lat, longitude: point.lng },
            { latitude: rp.lat, longitude: rp.lng }
        );
        if (d < minDistance) minDistance = d;
    });
    return minDistance;
}

function buildTrackingLink(req, id) {
    const host = req ? `${req.protocol}://${req.get("host")}` : `http://localhost:8001`;
    return `${host}/#${id}`;
}

// ========================
// CONFIG / HAZARD ENDPOINTS
// ========================
app.get("/config", (req, res) => {
    res.json({
        googleMapsKey: googleMapsKey || "",
        hasGoogle: !!googleMapsKey,
        hasTwilio: !!client,
        hasN8n: !!n8nWebhookUrl
    });
});

app.get("/hazards", (req, res) => {
    const hour = new Date().getHours();
    const active = hazardZones.filter(z => isZoneActive(z, hour));
    res.json({ total: hazardZones.length, active: active.length, zones: hazardZones });
});

app.post("/hazards", (req, res) => {
    const zone = req.body;
    if (!zone.id || !zone.polygon || !Array.isArray(zone.polygon)) {
        return res.status(400).json({ error: "id and polygon[] required" });
    }
    const idx = hazardZones.findIndex(z => z.id === zone.id);
    if (idx >= 0) hazardZones[idx] = zone; else hazardZones.push(zone);
    saveHazardZones();
    res.json({ success: true, total: hazardZones.length });
});

app.delete("/hazards/:id", (req, res) => {
    hazardZones = hazardZones.filter(z => z.id !== req.params.id);
    saveHazardZones();
    res.json({ success: true });
});

// ========================
// GEOCODE (frontend/n8n can resolve text → coords)
// ========================
app.post("/geocode", async (req, res) => {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: "address required" });
    try {
        const result = await geocodeAddress(address);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================
// ROUTE ANALYSIS (pre-trip preview)
// ========================
app.post("/analyze-route", async (req, res) => {
    let { startLat, startLng, destLat, destLng, destinationText, startText, mode } = req.body;

    try {
        if (!startLat && startText) {
            const g = await geocodeAddress(startText);
            startLat = g.lat; startLng = g.lng;
        }
        if (!destLat && destinationText) {
            const g = await geocodeAddress(destinationText);
            destLat = g.lat; destLng = g.lng;
        }
        if (!startLat || !destLat) {
            return res.status(400).json({ error: "need start + destination coords or text" });
        }
        const result = await fetchSafestRoute(startLat, startLng, destLat, destLng, mode || "walking");
        res.json({
            ...result,
            analyzedAt: new Date().toISOString(),
            start: { lat: startLat, lng: startLng },
            destination: { lat: destLat, lng: destLng }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================
// CREATE SESSION
// Body: { destination: "Bandra Station" | {lat,lng,label},
//         currentLocation: {lat,lng},
//         phone: "+91...",
//         guardianPhone: "+91...",
//         mode: "walking"|"driving" }
// ========================
app.post("/create", async (req, res) => {
    const { destination, phone, guardianPhone, currentLocation, mode } = req.body;
    const id = Date.now().toString();

    // Resolve destination
    let destCoord = null, destLabel = "Unknown";
    try {
        if (typeof destination === "string") {
            const g = await geocodeAddress(destination);
            destCoord = { lat: g.lat, lng: g.lng };
            destLabel = g.label;
        } else if (destination && destination.lat) {
            destCoord = { lat: destination.lat, lng: destination.lng };
            destLabel = destination.label || destination.name || `${destination.lat},${destination.lng}`;
        }
    } catch (err) {
        return res.status(400).json({ error: `Destination resolution failed: ${err.message}` });
    }

    // Fetch safest route
    let routeResult = null;
    if (currentLocation && destCoord) {
        try {
            routeResult = await fetchSafestRoute(
                currentLocation.lat, currentLocation.lng,
                destCoord.lat, destCoord.lng,
                mode || "walking"
            );
        } catch (err) {
            console.error("Route fetch failed:", err.message);
        }
    }

    const routePoints = routeResult?.chosen?.points || [];
    const safetyScore = routeResult?.chosen?.safety || scoreRoute(routePoints);

    sessions[id] = {
        id,
        destination: destLabel,
        destinationCoords: destCoord,
        phone: phone || null,
        guardianPhone: guardianPhone || null,
        mode: mode || "walking",
        status: "ACTIVE",
        currentLocation: currentLocation || null,
        pathHistory: currentLocation ? [currentLocation] : [],
        expectedRoute: routePoints,
        alternativeRoutes: routeResult?.alternatives?.map(a => ({
            points: a.points, safety: a.safety, combinedScore: a.combinedScore,
            duration: a.duration, distance: a.distance
        })) || [],
        safetyScore,
        lastPing: Date.now(),
        deviationCount: 0,
        alert: null,
        sosTriggered: false,
        alertsSent: false,
        createdAt: Date.now()
    };

    saveSessions();
    const trackingLink = buildTrackingLink(req, id);

    // Notify n8n of new session (optional outbound)
    if (n8nIntakeWebhook) {
        fetch(n8nIntakeWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                event: "VAJRA_SESSION_CREATED",
                sessionId: id,
                destination: destLabel,
                phone, guardianPhone,
                trackingLink,
                safetyScore
            })
        }).catch(e => console.error("n8n intake notify failed:", e.message));
    }

    res.json({
        sessionId: id,
        trackingLink,
        safetyScore,
        routePoints,
        alternatives: sessions[id].alternativeRoutes.length
    });
});

// ========================
// LOCATION PING
// ========================
app.post("/location", async (req, res) => {
    const { sessionId, lat, lng } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });

    const newPoint = { lat, lng };
    session.currentLocation = newPoint;
    session.pathHistory.push(newPoint);
    session.lastPing = Date.now();

    // 1. Immediate SOS if inside a high-risk zone
    const pointRisk = getPointRiskScore(lat, lng);
    if (pointRisk >= 8) {
        session.status = "RISK";
        session.alert = `Entered high-risk corridor (risk ${pointRisk}/10)`;
        await triggerSOS(session, req);
        saveSessions();
        return res.json({ success: true, status: session.status, risk: pointRisk });
    }

    // 2. Route deviation (3-strike)
    const distanceToRoute = getDistanceToRoute(newPoint, session.expectedRoute);
    if (distanceToRoute > 300) {
        session.deviationCount += 1;
        if (session.deviationCount >= 3 && !session.sosTriggered) {
            session.status = "RISK";
            session.alert = `Route deviation detected (${Math.round(distanceToRoute)}m off path)`;
            await triggerSOS(session, req);
        }
    } else {
        session.deviationCount = 0;
        if (session.status !== "RISK") session.status = "ACTIVE";
    }

    saveSessions();
    res.json({ success: true, status: session.status, distanceToRoute, riskAtPoint: pointRisk });
});

// ========================
// MANUAL SOS
// ========================
app.post("/sos", async (req, res) => {
    const { sessionId, escalatedByContact } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(404).json({ error: "Session not found" });

    session.sosTriggered = true;
    session.status = "RISK";
    session.alert = escalatedByContact ? "MANUAL ESCALATION BY CONTACT" : "Manual SOS triggered by user";

    await triggerSOS(session, req);
    saveSessions();
    res.json({ success: true, trackingLink: buildTrackingLink(req, sessionId) });
});

app.get("/sos", (req, res) => {
    res.send(`<h1>VAJRA SOS</h1><p>POST {sessionId} to this endpoint to trigger manual SOS.</p>`);
});

async function triggerSOS(session, req) {
    if (session.alertsSent) return;
    session.alertsSent = true;

    const trackingLink = buildTrackingLink(req, session.id);

    // BUG FIX: Corrected the Google Maps URL generation
    const locStr = session.currentLocation
        ? `https://maps.google.com/?q=${session.currentLocation.lat},${session.currentLocation.lng}`
        : "location unknown";

    const message = `🚨 VAJRA ALERT\n${session.alert}\nLast location: ${locStr}\nLive tracking: ${trackingLink}`;

    // 1. Notify n8n — n8n then handles Telegram/WhatsApp/email fan-out
    if (n8nWebhookUrl) {
        try {
            await fetch(n8nWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    event: "VAJRA_SOS_ALERT",
                    sessionId: session.id,
                    reason: session.alert,
                    trackingLink,
                    locationLink: locStr,
                    location: session.currentLocation,
                    destination: session.destination,
                    guardianPhone: session.guardianPhone,
                    phone: session.phone,
                    policeNumber,
                    safetyScore: session.safetyScore,
                    triggeredAt: new Date().toISOString()
                })
            });
        } catch (e) { console.error("n8n SOS webhook failed:", e.message); }
    }

    // 2. Direct Twilio fallback (in case n8n is down)
    if (client) {
        const targets = [session.guardianPhone, session.phone, policeNumber].filter(Boolean);
        for (const to of targets) {
            try {
                await client.messages.create({ body: message, from: twilioNumber, to });
                console.log(`SOS SMS → ${to}`);
            } catch (e) { console.error(`Twilio SMS to ${to} failed:`, e.message); }
        }
    }
}

// ========================
// TRACK / SESSIONS
// ========================
app.get("/track/:id", (req, res) => {
    const session = sessions[req.params.id];
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
});

app.get("/sessions", (req, res) => {
    const list = Object.values(sessions)
        .map(s => ({
            id: s.id, destination: s.destination, status: s.status,
            lastPing: s.lastPing, phone: s.phone || null, alert: s.alert || null,
            safetyScore: s.safetyScore || null, currentLocation: s.currentLocation || null
        }))
        .sort((a, b) => (b.lastPing || 0) - (a.lastPing || 0));
    res.json(list);
});

// ========================
// DEAD-MAN SWITCH — signal lost → SOS
// ========================
const NO_SIGNAL_MS = 3 * 60 * 1000;  // 3 min without ping = NO_SIGNAL
const AUTO_SOS_MS = 7 * 60 * 1000;  // 7 min → auto-escalate to SOS

setInterval(() => {
    const now = Date.now();
    let dirty = false;
    for (const session of Object.values(sessions)) {
        if (session.status === "RISK" || session.sosTriggered) continue;
        const gap = now - session.lastPing;
        if (gap > AUTO_SOS_MS && !session.sosTriggered) {
            session.status = "RISK";
            session.alert = `User unreachable for ${Math.round(gap / 60000)} min — auto-SOS`;
            session.sosTriggered = true;
            triggerSOS(session, null).catch(e => console.error("auto-SOS failed:", e.message));
            dirty = true;
        } else if (gap > NO_SIGNAL_MS && session.status !== "NO_SIGNAL") {
            session.status = "NO_SIGNAL";
            session.alert = "Signal lost — monitoring";
            dirty = true;
        }
    }
    if (dirty) saveSessions();
}, 30000);

// ========================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "frontend", "index.html")));

const PORT = process.env.PORT || 8001;
app.listen(PORT, () => {
    console.log(`\n🛡️  VAJRA Safety Server on :${PORT}`);
    console.log(`   Google Maps: ${googleMapsKey ? "✓" : "✗ NOT SET — routing will be mocked"}`);
    console.log(`   Twilio:      ${client ? "✓" : "✗"}`);
    console.log(`   n8n SOS:     ${n8nWebhookUrl ? "✓" : "✗"}`);
    console.log(`   n8n Intake:  ${n8nIntakeWebhook ? "✓" : "✗"}`);
    console.log(`   Hazards:     ${hazardZones.length} zones loaded\n`);
});