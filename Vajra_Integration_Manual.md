# Vajra Emergency System: Integration Manual

This document provides the exact technical specifications for your teammate to integrate the Telegram Bot with your backend.

## ⚙️ 0. How to Run the System Locally
To run the system locally, follow these steps:
1. Open a terminal and navigate to the backend folder:
   ```bash
   cd vajra-backend
   ```
2. Copy the `.env` file from the main project folder into the `vajra-backend` folder so the server can load your API keys.
3. Install the required Node.js dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   node server.js
   ```
Wait for the terminal to display `Server running on port 8001`. The backend is now ready and is serving both the API and the user-facing web dashboard!

## 🚀 1. Public Deployment (Ngrok)
To allow the Telegram bot to talk to your local backend, run this command in your terminal:
```bash
npx ngrok http 8001 --authtoken 3CUHSdOwPAZRB2tFAHQVwj8Vlea_5QEp1BXKFXEeEf6Su4tU8
```
**Share the "Forwarding" URL (e.g., `https://abcd-123.ngrok-free.app`) with your teammate.**

---

## 🤖 2. Bot Integration (For your Teammate)
The bot needs to make two main API calls to the Ngrok URL.

### A. Create a New Trip
**Endpoint**: `POST /create`  
**JSON Payload**:
```json
{
  "destination": "Chhatrapati Shivaji Terminus",
  "phone": "+919876543210",
  "expectedRoute": [
    {"lat": 19.0760, "lng": 72.8777},
    {"lat": 19.0800, "lng": 72.8850}
  ]
}
```
**Response**:
```json
{
  "sessionId": "1776432100555",
  "trackingLink": "https://your-ngrok.app/#1776432100555"
}
```
*Note: The bot should send the `trackingLink` to the Emergency Contact.*

### B. Update Live Location
**Endpoint**: `POST /location`  
**JSON Payload**:
```json
{
  "sessionId": "1776432100555",
  "lat": 19.0775,
  "lng": 72.8788
}
```

---

## 🛡️ 3. Dashboard Guide (For Emergency Contacts)
The dashboard is designed for the person tracking the trip (e.g., a parent).

1.  **Status Badge**:
    - `🟢 SAFE`: Everything is normal.
    - `🟠 SCANNING`: The server is looking for the trip data.
    - `🔴 ALERT`: The system detected a risk (deviation or signal loss).
    - `⚪ OFFLINE`: The backend server is not running.
2.  **Manual Escalation**:
    - If the contact suspects danger (e.g., no movement for 10 minutes), they can click **🚨 ESCALATE EMERGENCY**.
    - This triggers an immediate n8n webhook alert and starts the Twilio calling process.

---

## 💾 4. Reliability (Persistence)
Trips are now saved to `sessions.json`. 
- **NO DATA LOSS**: If your computer restarts, the trip is still active.
- **NO API ERRORS**: The "API ERROR" badge has been replaced with smart status messages.
