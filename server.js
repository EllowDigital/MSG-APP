const express = require('express');
const cors = require('cors');
require('dotenv').config();
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
// Render uses the PORT environment variable
const port = process.env.PORT || 3000;

// --- CRITICAL FIX: Trust the Render Proxy ---
// This tells Express to trust the 'X-Forwarded-For' header set by Render's proxy.
// This is necessary for the rate limiter to correctly identify the user's IP.
app.set('trust proxy', 1);

// --- Security: CORS Configuration ---
// Only allow requests from your specific frontend application URL.
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
    console.error("FATAL ERROR: Crucial Twilio credentials are not set in the environment variables.");
    process.exit(1);
}
const client = twilio(accountSid, authToken);


// --- Main Sending Endpoint ---
app.post('/send', limiter, async (req, res) => {
    // Destructure imageUrl along with other fields
    const { channel, recipient, message, imageUrl } = req.body;

    // 1. Updated Input Validation
    if (!channel || !recipient) {
        return res.status(400).json({ error: 'Missing required fields: channel or recipient.' });
    }
    if (!message && !imageUrl) {
        return res.status(400).json({ error: 'A message or an image URL is required.' });
    }

    const e164Regex = /^\+[1-9]\d{1,14}$/;
    if (!e164Regex.test(recipient)) {
        return res.status(400).json({ error: `Invalid phone number format: ${recipient}. Must be in E.164 format (e.g., +919876543210).` });
    }

    try {
        let result;
        let fromAddress;

        // 2. Determine the 'from' address
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

        // 3. Execute the API call, passing imageUrl to helpers
        switch (channel) {
            case 'sms':
                result = await sendSms(fromAddress, recipient, message, imageUrl);
                break;
            case 'whatsapp':
                result = await sendWhatsApp(fromAddress, recipient, message, imageUrl);
                break;
            case 'call':
                if (imageUrl) { // Calls cannot have images
                    return res.status(400).json({ error: 'Cannot send an image with a voice call.' });
                }
                result = await makeVoiceCall(fromAddress, recipient, message);
                break;
        }

        console.log(`Successfully initiated ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });

    } catch (error) {
        console.error(`Twilio API Error for ${recipient}:`, error.message);
        res.status(error.status || 500).json({ error: `Twilio Error: ${error.message}` });
    }
});


// --- Updated Twilio Helper Functions ---

async function sendSms(from, to, body, imageUrl) {
    const messageData = { from, to };
    if (body) messageData.body = body;
    if (imageUrl) messageData.mediaUrl = [imageUrl];
    return client.messages.create(messageData);
}

async function sendWhatsApp(from, to, body, imageUrl) {
    const messageData = { from, to: `whatsapp:${to}` };
    if (body) messageData.body = body;
    if (imageUrl) messageData.mediaUrl = [imageUrl];
    return client.messages.create(messageData);
}

async function makeVoiceCall(from, to, textToSay) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Aditi' }, textToSay); // Using a Polly voice for Indian accent
    twiml.hangup();
    return client.calls.create({ twiml: twiml.toString(), to, from });
}

app.listen(port, () => {
    console.log(`Advanced messaging server listening on port ${port}`);
});

