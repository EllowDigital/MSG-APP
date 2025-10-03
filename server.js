// server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

// --- CRITICAL FIX: Trust the Render Proxy ---
// This is essential for rate limiting to work correctly on hosting platforms like Render.
app.set('trust proxy', 1);

// --- Security: CORS Configuration ---
const frontendUrl = process.env.FRONTEND_URL;
if (!frontendUrl) {
    console.warn("WARNING: FRONTEND_URL is not set. For production, this is a security risk.");
}
const corsOptions = {
    origin: frontendUrl || "http://127.0.0.1:5500", // Fallback for local dev
};
app.use(cors(corsOptions));

// --- Middleware ---
app.use(express.json());

// --- Security: Rate Limiting ---
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});

// --- Twilio Client Initialization ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioSmsNumber = process.env.TWILIO_SMS_NUMBER;
const twilioWhatsAppSender = process.env.TWILIO_WHATSAPP_SENDER;

if (!accountSid || !authToken || !twilioSmsNumber || !twilioWhatsAppSender) {
    console.error("FATAL ERROR: Crucial Twilio credentials are not set in the environment variables. Please check your .env file.");
    process.exit(1);
}
const client = twilio(accountSid, authToken);

// --- Main Sending Endpoint ---
app.post('/send', limiter, async (req, res) => {
    const { channel, recipient, message, imageUrl } = req.body;

    // --- Input Validation ---
    if (!channel || !recipient) {
        return res.status(400).json({ error: 'Missing required fields: channel or recipient.' });
    }
    if (!message && !imageUrl) {
        return res.status(400).json({ error: 'A message or an image URL is required.' });
    }

    // E.164 format validation. This is a robust international format.
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(recipient)) {
        return res.status(400).json({ error: `Invalid phone number format: ${recipient}. Must be in E.164 format (e.g., +919876543210).` });
    }

    try {
        let fromAddress;
        switch (channel) {
            case 'sms':
            case 'call':
                fromAddress = twilioSmsNumber;
                break;
            case 'whatsapp':
                fromAddress = `whatsapp:${twilioWhatsAppSender}`;
                break;
            default:
                return res.status(400).json({ error: 'Invalid channel specified.' });
        }

        const messageOptions = {
            to: recipient,
            from: fromAddress,
        };

        if (channel === 'whatsapp') {
            messageOptions.to = `whatsapp:${recipient}`;
        }

        // --- Logic for creating the message payload ---
        let result;
        switch (channel) {
            case 'sms':
            case 'whatsapp':
                if (message) messageOptions.body = message;
                // **IMAGE SENDING LOGIC**: For MMS/WhatsApp media, Twilio expects `mediaUrl` to be an array of public URLs.
                // ** TROUBLESHOOTING **
                // 1. Is the `imageUrl` a publicly accessible URL? Try opening it in an incognito browser window.
                // 2. Is your Twilio phone number (`TWILIO_SMS_NUMBER`) MMS-enabled? Check your number's capabilities in the Twilio console.
                // 3. For WhatsApp, are you using the Sandbox? Media is only supported on paid accounts or with pre-approved templates.
                if (imageUrl) messageOptions.mediaUrl = [imageUrl];
                result = await client.messages.create(messageOptions);
                break;

            case 'call':
                if (imageUrl) {
                    return res.status(400).json({ error: 'Cannot send an image with a voice call.' });
                }
                const twiml = new twilio.twiml.VoiceResponse();
                twiml.say({ voice: 'Polly.Aditi' }, message); // Indian Polly voice
                twiml.hangup();
                messageOptions.twiml = twiml.toString();
                result = await client.calls.create(messageOptions);
                break;
        }

        console.log(`Successfully initiated ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });

    } catch (error) {
        // **IMPROVED ERROR LOGGING**: We now log the entire error object.
        // This will give you a Twilio error code (e.g., 21610) which you can look up for specific solutions.
        console.error(`Twilio API Error for ${recipient}:`, error);
        res.status(error.status || 500).json({ error: `Twilio Error: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Advanced messaging server listening on port ${port}`);
});