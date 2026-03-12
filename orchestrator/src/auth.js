import { google } from "googleapis";
import { GOOGLE_AUTH } from "./config.js";

// Scopes required by the downstream services
const SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/gmail.readonly",
];

/**
 * Generate the URL that the user must visit to authorize the application.
 */
export function getAuthUrl() {
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_AUTH.clientId,
        GOOGLE_AUTH.clientSecret,
        GOOGLE_AUTH.redirectUri
    );
    return oauth2Client.generateAuthUrl({
        access_type: "offline", // Required to get a refresh token
        prompt: "consent",      // Force consent screen to always get a refresh token
        scope: SCOPES,
    });
}

/**
 * Instantiate an OAuth2 client from a given token object (from cookies).
 * Returns the current valid access token.
 */
export async function getValidAccessToken(credentials) {
    if (!credentials) throw new Error("No credentials provided");
    
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_AUTH.clientId,
        GOOGLE_AUTH.clientSecret,
        GOOGLE_AUTH.redirectUri
    );
    oauth2Client.setCredentials(credentials);
    const tokenUrl = await oauth2Client.getAccessToken();
    return tokenUrl.token;
}

/**
 * Exchange an authorization code for access/refresh tokens.
 */
export async function exchangeCodeForTokens(code) {
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_AUTH.clientId,
        GOOGLE_AUTH.clientSecret,
        GOOGLE_AUTH.redirectUri
    );
    const { tokens } = await oauth2Client.getToken(code);
    return tokens;
}


