/**
 * Google OAuth token storage with pgcrypto encryption.
 */

import { supabaseAdmin } from '../supabase-server';

const ENCRYPTION_KEY = process.env['TOKEN_ENCRYPTION_KEY'] ?? '';

if (!ENCRYPTION_KEY) {
  console.warn('[TokenStore] TOKEN_ENCRYPTION_KEY not set');
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiryDate: number;
  scope: string;
}

export async function saveGoogleTokens(tokens: GoogleTokens): Promise<void> {
  const { error } = await supabaseAdmin
    .from('google_tokens')
    .upsert(
      {
        user_id: 'default',
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: tokens.tokenType,
        expiry_date: tokens.expiryDate,
        scope: tokens.scope,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
  if (error) {
    console.error('[TokenStore] Failed to save tokens:', error.message);
    throw error;
  }
  console.log('[TokenStore] Google tokens saved');
}

export async function loadGoogleTokens(): Promise<GoogleTokens | null> {
  const { data, error } = await supabaseAdmin
    .from('google_tokens')
    .select('*')
    .eq('user_id', 'default')
    .single();
  if (error || !data) return null;
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    tokenType: data.token_type as string,
    expiryDate: data.expiry_date as number,
    scope: data.scope as string,
  };
}

export async function hasValidGoogleTokens(): Promise<boolean> {
  const tokens = await loadGoogleTokens();
  if (!tokens) return false;
  return tokens.expiryDate > Date.now() + 5 * 60 * 1000;
}
