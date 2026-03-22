import { google } from "googleapis";
import { GOOGLE_AUTH } from "./config.js";

function decodeJwtPayload(jwt) {
    try {
        const parts = String(jwt).split(".");
        if (parts.length < 2) return null;
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return payload && typeof payload === "object" ? payload : null;
    } catch {
        return null;
    }
}

// Scopes required by the downstream services
const SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "openid",
];

/**
 * Generate the URL that the user must visit to authorize the application.
 */
export function getAuthUrl(options = {}) {
    const prompt = options.selectAccount ? "select_account consent" : "consent";
    const statePayload = JSON.stringify({
        returnTo: typeof options.returnTo === "string" && options.returnTo.startsWith("/")
            ? options.returnTo
            : "/",
        returnOrigin: typeof options.returnOrigin === "string"
            ? options.returnOrigin
            : null,
    });
    const state = Buffer.from(statePayload).toString("base64url");

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_AUTH.clientId,
        GOOGLE_AUTH.clientSecret,
        GOOGLE_AUTH.redirectUri
    );
    return oauth2Client.generateAuthUrl({
        access_type: "offline", // Required to get a refresh token
        prompt,
        scope: SCOPES,
        state,
    });
}

export function parseAuthState(state) {
    if (!state || typeof state !== "string") {
        return { returnTo: "/", returnOrigin: null };
    }

    try {
        const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
        if (parsed && typeof parsed.returnTo === "string" && parsed.returnTo.startsWith("/")) {
            return {
                returnTo: parsed.returnTo,
                returnOrigin: typeof parsed.returnOrigin === "string" ? parsed.returnOrigin : null,
            };
        }
    } catch {
        // Ignore malformed state and use default fallback.
    }

    return { returnTo: "/", returnOrigin: null };
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

/**
 * Fetch the signed-in Google account profile from credentials.
 */
export async function getGoogleProfile(credentials) {
    if (!credentials) throw new Error("No credentials provided");

    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_AUTH.clientId,
        GOOGLE_AUTH.clientSecret,
        GOOGLE_AUTH.redirectUri
    );
    oauth2Client.setCredentials(credentials);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    try {
        const { data } = await oauth2.userinfo.get();
        return {
            email: data.email ?? null,
            name: data.name ?? null,
            picture: data.picture ?? null,
        };
    } catch {
        // Fallback for tokens missing userinfo accessibility: read claims from id_token.
        const claims = decodeJwtPayload(credentials.id_token);
        return {
            email: claims?.email ?? null,
            name: claims?.name ?? null,
            picture: claims?.picture ?? null,
        };
    }
}


