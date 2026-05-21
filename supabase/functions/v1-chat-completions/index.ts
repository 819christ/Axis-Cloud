import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GATEWAY_URL = Deno.env.get("GATEWAY_URL") || "http://localhost:3000";

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

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 450,
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

    // Récupérer l'utilisateur correspondant à la clé Axis
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, email, kaggle_api_token, is_pro")
      .eq("axis_api_key", axisApiKey)
      .single();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: "Invalid Axis API Key" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Parse du body
    const body = await req.json();
    const { model, messages } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Invalid or empty messages array" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Récupérer le prompt textuel à envoyer au modèle
    const latestMessage = messages[messages.length - 1].content;

    // 3. Insertion du job en file d'attente
    const { data: job, error: jobError } = await supabase
      .from("jobs_queue")
      .insert({
        user_id: profile.id,
        model_target: model || "axis-pro",
        prompt_input: { messages },
        status: "en_attente",
      })
      .select("id")
      .single();

    if (jobError || !job) {
      return new Response(JSON.stringify({ error: "Failed to queue the job", details: jobError }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const jobId = job.id;

    // 4. Déclencher le processus d'inférence Kaggle en tâche de fond (asynchrone)
    // Nous lançons l'opération asynchrone sans attendre ('await') sa fin
    triggerKaggleInference(jobId, profile, latestMessage).catch((err) => {
      console.error(`[Error in background Kaggle inference for job ${jobId}]:`, err);
    });

    // 5. Retourner 202 Accepted immédiatement
    const checkStatusUrl = SUPABASE_URL && SUPABASE_URL.includes("supabase.co")
      ? `${SUPABASE_URL}/functions/v1/v1-jobs-status?id=${jobId}`
      : `${GATEWAY_URL}/v1/jobs/status?id=${jobId}`;

    return new Response(
      JSON.stringify({
        status: "queued",
        job_id: jobId,
        check_status_url: checkStatusUrl,
      }),
      {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Fonction asynchrone de fond pour lancer l'inférence Kaggle
async function triggerKaggleInference(jobId: string, profile: any, promptText: string) {
  // Mettre le statut à 'processing'
  await supabase
    .from("jobs_queue")
    .update({ status: "processing" })
    .eq("id", jobId);

  // Récupérer les identifiants Kaggle
  let kaggleCreds;
  try {
    // Si la clé est stockée chiffrée, nous la déchiffrons. 
    // Pour la démo et le simulateur, on suppose qu'elle contient JSON stringifié : {"username": "...", "key": "..."}
    kaggleCreds = JSON.parse(profile.kaggle_api_token);
  } catch (_e) {
    console.error("Format de clé Kaggle invalide dans le profil");
    await updateJobFailed(jobId, "Format de token Kaggle invalide");
    return;
  }

  const { username, key } = kaggleCreds;
  if (!username || !key) {
    await updateJobFailed(jobId, "Identifiants Kaggle manquants");
    return;
  }

  // Si l'utilisateur est PRO, on applique la régulation du débit (Rate Limiting) 
  // pour s'assurer de ne pas saturer ses RPM sur Kaggle.
  if (profile.is_pro) {
    await applyProRateLimiting(profile.id);
  }

  try {
    // Générer un slug unique pour le noyau de traitement Kaggle
    const kernelSlug = `axis-job-${jobId.slice(0, 8)}`;
    
    // Script Python qui sera poussé sur Kaggle
    const pythonCode = `
import json
import os

# Injecter le prompt de l'utilisateur
prompt = """${promptText.replace(/"""/g, '\\"\\"\\""')}"""

# Essayer de faire l'inférence en utilisant les quotas IA de Kaggle (via Gemini par exemple)
try:
    import google.generativeai as genai
    # Kaggle configure automatiquement les clés si l'environnement est actif
    model = genai.GenerativeModel('gemini-1.5-flash')
    response = model.generate_content(prompt)
    output = {
        "choices": [{
            "message": {
                "role": "assistant",
                "content": response.text
            }
        }]
    }
except Exception as e:
    output = {
        "error": str(e)
    }

# Écrire le résultat dans le fichier de sortie
with open('output.json', 'w') as f:
    json.dump(output, f)
print("Inference completed successfully!")
`;

    // Authentification de base pour l'API Kaggle
    const authString = btoa(`${username}:${key}`);
    const headers = {
      "Authorization": `Basic ${authString}`,
      "Content-Type": "application/json",
    };

    // Pousser le Kernel via l'API Kaggle
    const pushPayload = {
      id: `${username}/${kernelSlug}`,
      title: `Axis Job ${jobId}`,
      code: pythonCode,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: false,
      enableTpu: false,
      enableInternet: true,
      datasetDataSources: [],
      modelDataSources: [],
      kernelDataSources: [],
      competitionDataSources: []
    };

    console.log(`[Kaggle Push] Lancement du noyau pour le job ${jobId}`);
    const pushRes = await fetch("https://www.kaggle.com/api/v1/kernels/push", {
      method: "POST",
      headers,
      body: JSON.stringify(pushPayload),
    });

    if (!pushRes.ok) {
      const errorText = await pushRes.text();
      throw new Error(`Kaggle Kernel Push failed: ${errorText}`);
    }

    // Boucle de polling du statut du Kernel sur Kaggle (toutes les 5 secondes)
    const maxRetries = 60; // 5 minutes max
    let retries = 0;
    let completed = false;

    while (retries < maxRetries && !completed) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      retries++;

      const statusRes = await fetch(`https://www.kaggle.com/api/v1/kernels/status?kernelRef=${username}/${kernelSlug}`, {
        headers,
      });

      if (!statusRes.ok) {
        console.warn(`[Kaggle Poll] Erreur de vérification du statut: ${statusRes.statusText}`);
        continue;
      }

      const statusData = await statusRes.json();
      const status = statusData.status; // 'queued', 'running', 'complete', 'error'

      console.log(`[Kaggle Poll] Job ${jobId} - Statut actuel : ${status}`);

      if (status === "complete") {
        completed = true;
        // Récupérer le fichier de sortie
        const outputRes = await fetch(`https://www.kaggle.com/api/v1/kernels/output?kernelRef=${username}/${kernelSlug}`, {
          headers,
        });

        if (!outputRes.ok) {
          throw new Error("Impossible de récupérer la sortie du Kernel Kaggle");
        }

        const outputData = await outputRes.json();
        // Rechercher le fichier output.json
        const outputFile = outputData.files.find((f: any) => f.name === "output.json");
        if (!outputFile) {
          throw new Error("Fichier output.json introuvable dans la sortie Kaggle");
        }

        // Télécharger le contenu du fichier output.json
        const downloadRes = await fetch(outputFile.url);
        if (!downloadRes.ok) {
          throw new Error("Échec du téléchargement du fichier output.json");
        }

        const result = await downloadRes.json();

        if (result.error) {
          throw new Error(result.error);
        }

        // Enregistrer la réponse dans la base de données
        await supabase
          .from("jobs_queue")
          .update({
            status: "completed",
            prompt_output: result,
          })
          .eq("id", jobId);

        console.log(`[Success] Job ${jobId} terminé avec succès`);
      } else if (status === "error") {
        throw new Error(`Erreur lors de l'exécution du script Kaggle: ${statusData.failureMessage || "Inconnu"}`);
      }
    }

    if (!completed) {
      throw new Error("Temps d'attente maximum dépassé sur Kaggle (Timeout)");
    }

  } catch (err) {
    console.error(`[Inference Error] ${err.message}`);
    await updateJobFailed(jobId, err.message);
  }
}

async function updateJobFailed(jobId: string, message: string) {
  await supabase
    .from("jobs_queue")
    .update({
      status: "failed",
      error_message: message,
    })
    .eq("id", jobId);
}

// Fonction de lissage et de limitation pour les comptes PRO
async function applyProRateLimiting(userId: string) {
  // Récupérer le nombre de requêtes en cours pour cet utilisateur
  const { count } = await supabase
    .from("jobs_queue")
    .select("id", { count: "exact" })
    .eq("user_id", userId)
    .eq("status", "processing");

  // Si déjà plus de 2 jobs en cours d'exécution, attendre un peu avant de lancer le suivant
  if (count && count > 2) {
    console.log(`[Pro Regulation] Utilisateur ${userId} a ${count} tâches actives. Pause de lissage...`);
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
}
