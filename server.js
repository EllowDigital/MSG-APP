// server.js

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2; // Import Cloudinary

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
    // This MUST match your Netlify URL in your Render Environment Variables
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
    console.error("FATAL ERROR: Crucial Twilio credentials are not set in the environment variables. Please check your .env file or Render dashboard.");
    process.exit(1);
}
const client = twilio(accountSid, authToken);

// --- Cloudinary Configuration ---
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;

if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
    console.error("FATAL ERROR: Cloudinary credentials are not set. Please check your .env file or Render dashboard.");
    process.exit(1);
}
cloudinary.config({
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    api_secret: cloudinaryApiSecret,
    secure: true
});

// --- API Endpoint: Get Cloudinary Signature ---
// This new endpoint provides a secure signature for the frontend to upload directly to Cloudinary
app.get('/api/sign-upload', limiter, (req, res) => {
    try {
        const timestamp = Math.round((new Date).getTime() / 1000);

        // This creates a secure signature for the upload
        // It's valid for 10 minutes (600 seconds)
        const signature = cloudinary.utils.api_sign_request(
            {
                timestamp: timestamp,
                folder: 'twilio_audio' // Organizes uploads in Cloudinary
            },
            cloudinaryApiSecret
        );

        res.status(200).json({
            timestamp: timestamp,
            signature: signature,
            apiKey: cloudinaryApiKey,
            cloudName: cloudinaryCloudName
        });
    } catch (error) {
        console.error("Error signing upload request:", error);
        res.status(500).json({ error: "Could not sign upload request." });
    }
});


// --- API Endpoint: Send Message ---
app.post('/send', limiter, async (req, res) => {
    const { channel, recipient, message, imageUrl, callType, audioUrl } = req.body;

    // --- Input Validation ---
    if (!channel || !recipient) {
        return res.status(400).json({ error: 'Missing required fields: channel or recipient.' });
    }

    // Advanced validation for different channels and types
    if (channel === 'call') {
        if (callType === 'tts' && !message) {
            return res.status(400).json({ error: 'A message is required for text-to-speech calls.' });
        }
        if (callType === 'audio' && !audioUrl) {
            return res.status(400).json({ error: 'An audio URL is required for audio file calls.' });
        }
    } else if (!message && !imageUrl) {
        // This is for SMS/WhatsApp
        return res.status(400).json({ error: 'A message or an image URL is required.' });
    }

    // E.164 format validation
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
                if (imageUrl) messageOptions.mediaUrl = [imageUrl];
                result = await client.messages.create(messageOptions);
                break;

            case 'call':
                if (imageUrl) {
                    return res.status(400).json({ error: 'Cannot send an image with a voice call.' });
                }

                const twiml = new twilio.twiml.VoiceResponse();

                // Dynamic logic for voice calls
                if (callType === 'audio') {
                    // Use <Play> for the pre-recorded Cloudinary file
                    twiml.play(audioUrl);
                } else {
                    // This is your original Text-to-Speech (TTS) logic
                    twiml.say({ voice: 'Polly.Aditi' }, message); // Indian Polly voice
                }

                twiml.hangup();
                messageOptions.twiml = twiml.toString();
                result = await client.calls.create(messageOptions);
                break;
        }

        console.log(`Successfully initiated ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });

    } catch (error) {
        // Improved error logging
        console.error(`Twilio API Error for ${recipient}:`, error);
        res.status(error.status || 500).json({ error: `Twilio Error: ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Advanced messaging server listening on port ${port}`);
});

