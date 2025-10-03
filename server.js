const express = require('express');
const cors = require('cors');
require('dotenv').config();
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
// Heroku & Render use the PORT environment variable
const port = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// --- Security: Rate Limiting ---
// Apply a rate limit to the /send endpoint to prevent abuse.
// This allows 100 requests per 15-minute window from a single IP.
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
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
// Apply the rate limiter only to this endpoint.
app.post('/send', limiter, async (req, res) => {
    const { channel, recipient, message } = req.body;

    // 1. Robust Input Validation
    if (!channel || !recipient || !message) {
        return res.status(400).json({ error: 'Missing required fields: channel, recipient, or message.' });
    }

    // Validate E.164 format for the recipient number
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
                return res.status(400).json({ error: 'Invalid channel specified. Must be sms, whatsapp, or call.' });
        }

        // 3. Execute the API call
        switch (channel) {
            case 'sms':
                result = await sendSms(fromAddress, recipient, message);
                break;
            case 'whatsapp':
                result = await sendWhatsApp(fromAddress, recipient, message);
                break;
            case 'call':
                result = await makeVoiceCall(fromAddress, recipient, message);
                break;
        }

        console.log(`Successfully initiated ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });

    } catch (error) {
        // 4. Improved Error Handling
        // Log the detailed error on the server
        console.error(`Twilio API Error for ${recipient}:`, error.message);
        // Send a user-friendly error back to the client
        res.status(error.status || 500).json({ error: `Twilio Error: ${error.message}` });
    }
});


// --- Twilio Helper Functions ---

async function sendSms(from, to, body) {
    return client.messages.create({ body, from, to });
}

async function sendWhatsApp(from, to, body) {
    return client.messages.create({ from, body, to: `whatsapp:${to}` });
}

async function makeVoiceCall(from, to, textToSay) {
    const twiml = new twilio.twiml.VoiceResponse();
    // Using a more natural-sounding Polly voice
    twiml.say({ voice: 'Polly.Aditi' }, textToSay);
    twiml.hangup();

    return client.calls.create({ twiml: twiml.toString(), to, from });
}

app.listen(port, () => {
    console.log(`Advanced messaging server listening at http://localhost:${port}`);
});