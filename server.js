// server.js
// 🛠️ Install dependencies:
// npm install express cors dotenv twilio express-rate-limit cloudinary

const express = require('express');
const cors = require('cors');
require('dotenv').config(); // Load environment variables first
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2; // Import Cloudinary v2

const app = express();
const port = process.env.PORT || 3000;

// --- CRITICAL FIX: Trust the Render Proxy ---
// Essential for rate limiting behind proxies like Render.
app.set('trust proxy', 1);

// --- Security: CORS Configuration ---
const frontendUrl = process.env.FRONTEND_URL;
if (!frontendUrl) {
    // Log a warning if the frontend URL isn't set in production, but allow for local dev.
    console.warn("WARNING: FRONTEND_URL environment variable is not set. CORS will fallback to allow localhost, but this should be configured for production deployment.");
}
const corsOptions = {
    // Dynamically set origin based on environment variable, fallback for local development
    origin: frontendUrl || ["http://127.0.0.1:5500", "http://localhost:5500"], // Allow standard local dev ports
    methods: ['GET', 'POST'], // Specify allowed methods
    allowedHeaders: ['Content-Type'], // Specify allowed headers
};
app.use(cors(corsOptions));

// --- Middleware ---
app.use(express.json()); // Parse JSON bodies

// --- Security: Rate Limiting ---
// Apply rate limiting to all API requests to prevent abuse.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests from this IP, please try again after 15 minutes.' }
});
app.use('/api/', apiLimiter); // Apply limiter only to API routes
app.use('/send', apiLimiter); // Apply limiter to the send route as well


// --- Twilio Client Initialization ---
// Ensure all required Twilio environment variables are present.
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioSmsNumber = process.env.TWILIO_SMS_NUMBER;
const twilioWhatsAppSender = process.env.TWILIO_WHATSAPP_SENDER; // Corrected variable name

if (!accountSid || !authToken || !twilioSmsNumber || !twilioWhatsAppSender) {
    console.error("FATAL ERROR: Crucial Twilio credentials (SID, AuthToken, SMS Number, WhatsApp Sender) are not set in environment variables. Server cannot start.");
    process.exit(1); // Exit if essential config is missing
}
// Initialize Twilio client
const client = twilio(accountSid, authToken);

// --- Cloudinary Configuration ---
// Ensure all required Cloudinary environment variables are present.
const cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME;
const cloudinaryApiKey = process.env.CLOUDINARY_API_KEY;
const cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET;

if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
    console.error("FATAL ERROR: Cloudinary credentials (Cloud Name, API Key, API Secret) are not set in environment variables. Server cannot start.");
    process.exit(1); // Exit if essential config is missing
}
// Configure Cloudinary SDK
cloudinary.config({
    cloud_name: cloudinaryCloudName,
    api_key: cloudinaryApiKey,
    api_secret: cloudinaryApiSecret,
    secure: true // Use HTTPS for all Cloudinary URLs
});

// --- API Endpoint: Get Cloudinary Signature ---
// Handles signing requests for both audio and image uploads.
app.get('/api/sign-upload', (req, res) => { // Removed limiter here as it's applied globally to /api/
    try {
        const timestamp = Math.round((new Date).getTime() / 1000);
        const uploadType = req.query.type; // Get 'audio' or 'image' from query parameter

        let folder;
        // Determine the Cloudinary folder based on the upload type.
        if (uploadType === 'image') {
            folder = 'twilio_images'; // Folder for images
        } else if (uploadType === 'audio') {
            folder = 'twilio_audio'; // Folder for audio
        } else {
            // If type is missing or invalid, return an error.
            return res.status(400).json({ error: "Missing or invalid 'type' query parameter. Must be 'audio' or 'image'." });
        }

        // Generate a secure signature for the upload request.
        const signature = cloudinary.utils.api_sign_request(
            {
                timestamp: timestamp,
                folder: folder // Use the determined folder
            },
            cloudinaryApiSecret
        );

        // Send back the necessary details for the frontend upload.
        res.status(200).json({
            timestamp: timestamp,
            signature: signature,
            apiKey: cloudinaryApiKey,
            cloudName: cloudinaryCloudName,
            folder: folder // Return the folder used
        });
    } catch (error) {
        console.error("Error signing Cloudinary upload request:", error);
        res.status(500).json({ error: "Internal server error: Could not sign upload request." });
    }
});


// --- API Endpoint: Send Message ---
// Handles sending messages via SMS, WhatsApp, or Voice Call.
app.post('/send', async (req, res) => { // Removed limiter here as it's applied globally
    // Destructure necessary fields from request body.
    const { channel, recipient, message, imageUrl, callType, audioUrl } = req.body;

    // --- Input Validation ---
    if (!channel || !recipient) {
        return res.status(400).json({ error: 'Missing required fields: channel or recipient.' });
    }

    // Validate based on channel and type.
    if (channel === 'call') {
        if (callType === 'tts' && !message) {
            return res.status(400).json({ error: 'Message is required for text-to-speech calls.' });
        }
        if (callType === 'audio' && (!audioUrl || !audioUrl.startsWith('https://res.cloudinary.com'))) { // Basic check for Cloudinary URL
            return res.status(400).json({ error: 'Valid Cloudinary Audio URL is required for audio file calls.' });
        }
        if (imageUrl) { // Cannot send images with calls
            return res.status(400).json({ error: 'Cannot send an image with a voice call.' });
        }
    } else if (channel === 'sms' || channel === 'whatsapp') {
        if (!message && !imageUrl) { // Must have message or image for SMS/WA
            return res.status(400).json({ error: 'A message or an image URL is required for SMS/WhatsApp.' });
        }
        if (imageUrl && !imageUrl.startsWith('https://res.cloudinary.com')) { // Basic check for Cloudinary URL
            // Allow sending without image if URL is somehow invalid, but log a warning
            console.warn(`Potential issue: Invalid Image URL provided for ${channel}: ${imageUrl}. Proceeding without image.`);
            // Optionally, you could return an error here instead:
            // return res.status(400).json({ error: 'Invalid Image URL provided. Must be a Cloudinary URL.' });
        }
    } else {
        return res.status(400).json({ error: 'Invalid channel specified.' });
    }


    // E.164 phone number format validation.
    const e164Regex = /^\+[1-9]\d{1,14}$/; // Standard E.164 regex
    if (!e164Regex.test(recipient)) {
        return res.status(400).json({ error: `Invalid phone number: ${recipient}. Must be in E.164 format (e.g., +919876543210).` });
    }

    // --- Twilio API Call ---
    try {
        let fromAddress;
        let toAddress = recipient; // Default to recipient

        // Set 'from' and potentially modify 'to' based on channel.
        switch (channel) {
            case 'sms':
            case 'call':
                fromAddress = twilioSmsNumber;
                break;
            case 'whatsapp':
                fromAddress = `whatsapp:${twilioWhatsAppSender}`;
                toAddress = `whatsapp:${recipient}`; // Add prefix for WhatsApp recipient
                break;
            // Default case handled by earlier validation
        }

        // Base options for Twilio API call.
        const messageOptions = {
            to: toAddress,
            from: fromAddress,
        };

        let result; // To store the Twilio API response

        // --- Channel-Specific Logic ---
        switch (channel) {
            case 'sms':
            case 'whatsapp':
                // Add body and mediaUrl if provided.
                if (message) messageOptions.body = message;
                // Only add valid Cloudinary image URL
                if (imageUrl && imageUrl.startsWith('https://res.cloudinary.com')) {
                    messageOptions.mediaUrl = [imageUrl];
                }
                result = await client.messages.create(messageOptions);
                break;

            case 'call':
                const twiml = new twilio.twiml.VoiceResponse();
                // Generate TwiML based on callType.
                if (callType === 'audio') {
                    twiml.play(audioUrl); // Play the Cloudinary audio file.
                } else { // 'tts'
                    // Use Twilio's text-to-speech.
                    twiml.say({ voice: 'Polly.Aditi' }, message); // Using Polly Aditi voice (Indian English)
                }
                twiml.hangup(); // End the call after playing/saying.

                messageOptions.twiml = twiml.toString(); // Add generated TwiML to options.
                result = await client.calls.create(messageOptions);
                break;
        }

        // Log success and send response to frontend.
        console.log(`Successfully initiated ${channel} to ${recipient}. SID: ${result.sid}`);
        res.status(200).json({ success: true, sid: result.sid });

    } catch (error) {
        // Log detailed error and send appropriate status code.
        console.error(`Twilio API Error (${channel} to ${recipient}):`, error.message, `(Status: ${error.status}, Code: ${error.code})`); // Log more details
        // Provide a clearer error message to the frontend
        res.status(error.status || 500).json({
            error: `Twilio Error: ${error.message}` + (error.code ? ` (Code: ${error.code})` : '')
        });
    }
});

// --- Default Route for Health Check ---
app.get('/', (req, res) => {
    res.status(200).send('Messaging Server is running.');
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Advanced messaging server listening on port ${port}`);
    if (frontendUrl) {
        console.log(`CORS enabled for origin: ${frontendUrl}`);
    } else {
        console.log("CORS enabled for local development origins.");
    }
});

