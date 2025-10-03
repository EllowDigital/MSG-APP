const express = require('express');
const cors = require('cors');
require('dotenv').config();
const twilio = require('twilio');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- Twilio Client Initialization ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

// Load BOTH the SMS number and the WhatsApp sender from environment variables
const twilioSmsNumber = process.env.TWILIO_SMS_NUMBER;
const twilioWhatsAppSender = process.env.TWILIO_WHATSAPP_SENDER;

if (!accountSid || !authToken || !twilioSmsNumber || !twilioWhatsAppSender) {
    console.error("Crucial Twilio credentials are not set in the environment variables.");
    process.exit(1);
}
const client = twilio(accountSid, authToken);


// --- Main Sending Endpoint ---
app.post('/send', async (req, res) => {
    const { channel, recipient, message } = req.body;

    if (!channel || !recipient || !message) {
        return res.status(400).json({ error: 'Missing required fields: channel, recipient, message' });
    }

    try {
        let result;
        // 1. Define the 'from' number based on the channel
        let fromAddress;
        switch (channel) {
            case 'sms':
            case 'call': // Calls will also originate from your SMS-capable number
                fromAddress = twilioSmsNumber;
                break;
            case 'whatsapp':
                // For WhatsApp, we must add the 'whatsapp:' prefix
                fromAddress = `whatsapp:${twilioWhatsAppSender}`;
                break;
            default:
                return res.status(400).json({ error: 'Invalid channel specified.' });
        }

        // 2. Use the dynamic 'from' variable in the API call
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

        console.log(`Message sent/initiated via ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });
    } catch (error) {
        console.error(`Failed to send via ${channel} to ${recipient}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});


// --- Twilio Helper Functions ---
// Note: They now accept a 'from' parameter

async function sendSms(from, to, body) {
    return client.messages.create({
        body: body,
        from: from,
        to: to
    });
}

async function sendWhatsApp(from, to, body) {
    return client.messages.create({
        from: from,
        body: body,
        to: `whatsapp:${to}`
    });
}

async function makeVoiceCall(from, to, textToSay) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'alice' }, textToSay);
    twiml.hangup();

    return client.calls.create({
        twiml: twiml.toString(),
        to: to,
        from: from
    });
}

app.listen(port, () => {
    console.log(`Messaging server listening at http://localhost:${port}`);
});

