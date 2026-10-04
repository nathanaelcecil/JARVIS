/**
 * Google OAuth server functions.
 * Handles authorization URL generation and token exchange.
 */

import { createServerFn } from '@tanstack/react-start';
import { saveGoogleTokens, loadGoogleTokens, hasValidGoogleTokens } from '../lib/google/token-store';

const GOOGLE_CLIENT_ID = process.env['GOOGLE_CLIENT_ID'] ?? '';
const GOOGLE_CLIENT_SECRET = process.env['GOOGLE_CLIENT_SECRET'] ?? '';
const REDIRECT_URI = 'https://tanstack-start-ts.nathanaelcecil.workers.dev/api/auth/google/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

/**
 * Generate the Google OAuth authorization URL.
 */
export const getGoogleAuthUrl = createServerFn({ method: 'GET' }).handler(async () => {
  if (!GOOGLE_CLIENT_ID) {
    return { error: 'GOOGLE_CLIENT_ID not configured' };
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });

  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() };
});

/**
 * Exchange an authorization code for tokens and store them.
 */
export const exchangeGoogleCode = createServerFn({ method: 'POST' })
  .validator((code: string) => code)
  .handler(async ({ data: code }) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth credentials not configured');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error('Token exchange failed: ' + err);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };

    await saveGoogleTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      expiryDate: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    });

    return { success: true };
  });

/**
 * Refresh the access token using the stored refresh token.
 */
export async function refreshGoogleToken(): Promise<string> {
  const tokens = await loadGoogleTokens();
  if (!tokens?.refreshToken) throw new Error('No refresh token stored');

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth credentials not configured');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Token refresh failed: ' + err);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  // Save updated tokens
  await saveGoogleTokens({
    accessToken: data.access_token,
    refreshToken: tokens.refreshToken,
    tokenType: data.token_type,
    expiryDate: Date.now() + data.expires_in * 1000,
    scope: tokens.scope,
  });

  return data.access_token;
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getValidAccessToken(): Promise<string> {
  const tokens = await loadGoogleTokens();
  if (!tokens) throw new Error('Not authenticated with Google. Visit /api/auth/google to connect.');

  // Check if token is still valid (5-minute buffer)
  if (tokens.expiryDate > Date.now() + 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  // Token expired, refresh it
  return refreshGoogleToken();
}

/**
 * Check if Google auth is configured and connected.
 */
export const checkGoogleAuth = createServerFn({ method: 'GET' }).handler(async () => {
  const hasTokens = await hasValidGoogleTokens();
  return {
    configured: !!GOOGLE_CLIENT_ID,
    connected: hasTokens,
  };
});
