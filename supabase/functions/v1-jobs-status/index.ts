import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

serve(async (req) => {
  // Gérer les requêtes CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Authentification
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing or invalid Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const axisApiKey = authHeader.substring(7);

    // Vérifier l'utilisateur
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("axis_api_key", axisApiKey)
      .single();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: "Invalid Axis API Key" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Récupérer l'ID de la tâche
    const url = new URL(req.url);
    const jobId = url.searchParams.get("id");

    if (!jobId) {
      return new Response(JSON.stringify({ error: "Missing job ID parameter 'id'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Récupérer la tâche dans la table jobs_queue
    const { data: job, error: jobError } = await supabase
      .from("jobs_queue")
      .select("id, status, prompt_output, error_message, user_id")
      .eq("id", jobId)
      .single();

    if (jobError || !job) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sécurité supplémentaire : s'assurer que le job appartient à l'utilisateur de la clé API
    if (job.user_id !== profile.id) {
      return new Response(JSON.stringify({ error: "Access denied to this job" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Formater la réponse en fonction de l'état
    if (job.status === "completed") {
      return new Response(
        JSON.stringify({
          job_id: job.id,
          status: "completed",
          choices: job.prompt_output?.choices || [],
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } else if (job.status === "failed") {
      return new Response(
        JSON.stringify({
          job_id: job.id,
          status: "failed",
          error: job.error_message || "Une erreur inconnue est survenue lors de l'exécution sur Kaggle.",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } else {
      // Pour 'en_attente' ou 'processing'
      return new Response(
        JSON.stringify({
          job_id: job.id,
          status: job.status === "en_attente" ? "queued" : "processing",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
