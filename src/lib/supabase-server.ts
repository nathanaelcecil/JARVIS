import { createClient } from "@supabase/supabase-js";
import ws from "ws";

// Server-only: uses service role key, never exposed to browser
const supabaseUrl = process.env["VITE_SUPABASE_URL"] as string;
const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"] as string;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Missing Supabase server env vars. Check VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"
  );
}

// Pass ws as the realtime transport so the RealtimeClient can initialize
// without a native WebSocket global. We don't use realtime features,
// but supabase-js always creates a RealtimeClient internally.
export const supabaseAdmin = createClient(supabaseUrl ?? "", serviceRoleKey ?? "", {
  realtime: { transport: ws as unknown as typeof WebSocket },
});
