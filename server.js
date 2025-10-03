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
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber) {
    console.error("Twilio credentials are not set in the .env file.");
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
        switch (channel) {
            case 'sms':
                result = await sendSms(recipient, message);
                break;
            case 'whatsapp':
                result = await sendWhatsApp(recipient, message);
                break;
            case 'call':
                result = await makeVoiceCall(recipient, message);
                break;
            default:
                return res.status(400).json({ error: 'Invalid channel specified.' });
        }
        console.log(`Message sent/initiated via ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });
    } catch (error) {
        console.error(`Failed to send via ${channel} to ${recipient}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});


// --- Twilio Helper Functions ---

/**
 * Sends an SMS message.
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} body - The message content.
 */
async function sendSms(to, body) {
    return client.messages.create({
        body: body,
        from: twilioPhoneNumber,
        to: to
    });
}

/**
 * Sends a WhatsApp message.
 * Note: Requires an approved WhatsApp template for business-initiated messages
 * or the recipient must have contacted you in the last 24 hours.
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} body - The message content.
 */
async function sendWhatsApp(to, body) {
    return client.messages.create({
        from: `whatsapp:${twilioPhoneNumber}`,
        body: body,
        to: `whatsapp:${to}`
    });
}

/**
 * Initiates a voice call that reads out a message.
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} textToSay - The message to be converted to speech.
 */
async function makeVoiceCall(to, textToSay) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'alice' }, textToSay);
    twiml.hangup();

    return client.calls.create({
        twiml: twiml.toString(),
        to: to,
        from: twilioPhoneNumber
    });
}

app.listen(port, () => {
    console.log(`Messaging server listening at http://localhost:${port}`);
});

