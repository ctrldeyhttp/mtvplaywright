import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js"

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_KEY")!
)

serve(async () => {
  console.log("⏰ Running daily maintenance tasks")

  // 1. Reset USED emails
  const { error: resetError } = await supabase
    .from("emails")
    .update({
      status: null,
      reserved_at: null,
      duration_sec: null,
      votes_submitted: null,
      result_video: null,
      result_song: null,
      result_pop_artist: null,
      result_collab: null,
      result_pop: null,
      result_kpop: null,
      result_longform: null,
    })
    .eq("status", "USED")

  if (resetError) {
    console.error("Failed to reset emails", resetError)
    return new Response("Error resetting emails", { status: 500 })
  }

  // 2. Update daily summary
  // (Call your updateDailySummary() logic here, or inline replicate)

  return new Response("✅ Daily maintenance complete")
})
