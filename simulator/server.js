import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MOCK_KAGGLE = process.env.MOCK_KAGGLE !== "false"; // Actif par défaut

// =========================================================================
// POOLS DE MODÈLES - ROUTEUR MIXTURE OF EXPERTS (MoE)
// Chaque profil "axis-*" est une composition de plusieurs experts.
// Un petit modèle rapide (routeur) choisit le meilleur expert du pool.
// =========================================================================
const AXIS_MODEL_POOLS = {
  "axis-low": [
    "google/gemma-2-9b-it",
    "meta-llama/llama-3-8b-instruct",
    "mistralai/mistral-7b-instruct",
    "google/gemini-1.5-flash-latest",
  ],
  "axis-medium": [
    "google/gemma-2-9b-it",
    "google/gemma-2-27b-it",
    "meta-llama/llama-3-8b-instruct",
    "google/gemini-1.5-flash-latest",
  ],
  "axis-high": [
    "google/gemini-1.5-pro-latest",
    "meta-llama/llama-3-70b-instruct",
    "google/gemma-2-27b-it",
    "google/gemini-1.5-flash-latest",
  ],
  "axis-flash": [
    "google/gemini-1.5-flash-latest",
    "google/gemma-2-9b-it",
  ],
  "axis-pro": [
    "google/gemini-1.5-pro-latest",
    "meta-llama/llama-3-70b-instruct",
    "google/gemma-2-27b-it",
  ],
  "axis-coding": [
    "google/gemini-1.5-pro-latest",
    "google/gemma-2-27b-it",
    "meta-llama/llama-3-70b-instruct",
    "google/gemini-1.5-flash-latest",
  ],
};

// Modèle routeur : choisit le meilleur expert dans le pool
const ROUTER_MODEL = "google/gemini-1.5-flash-latest";

// =========================================================================
// BASE DE DONNÉES EN MÉMOIRE (SIMULATION SUPABASE)
// =========================================================================
const db = {
  users: new Map(),    // email -> user
  profiles: new Map(), // user_id -> profile
  jobs: new Map(),     // job_id -> job
};

// Compte de test pré-configuré
const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_EMAIL = "test@example.com";
const TEST_PASSWORD = "password123";

db.users.set(TEST_EMAIL, { id: TEST_USER_ID, email: TEST_EMAIL, password: TEST_PASSWORD });
db.profiles.set(TEST_USER_ID, {
  id: TEST_USER_ID,
  email: TEST_EMAIL,
  axis_api_key: "axis_test_key_abc123",
  kaggle_api_token: JSON.stringify({
    username: process.env.KAGGLE_USERNAME || "mock_kaggle_user",
    key: process.env.KAGGLE_KEY || "mock_kaggle_key",
  }),
  is_pro: true, // PRO par défaut pour tester le lissage
});

console.log("=== COMPTE DE TEST INITIALISÉ ===");
console.log(`Email      : ${TEST_EMAIL}`);
console.log(`Password   : ${TEST_PASSWORD}`);
console.log(`Axis Key   : axis_test_key_abc123`);
console.log(`Mode Kaggle: ${MOCK_KAGGLE ? "SIMULÉ" : "RÉEL"}`);
console.log("=================================\n");

// Serve frontend statique
app.use(express.static("public"));

// =========================================================================
// AUTHENTIFICATION (SIMULATION SUPABASE AUTH)
// =========================================================================

app.post("/api/auth/signup", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
  if (db.users.has(email)) return res.status(400).json({ error: "Cet utilisateur existe déjà" });

  const userId = crypto.randomUUID();
  db.users.set(email, { id: userId, email, password });
  const axis_api_key = `axis_${crypto.randomBytes(16).toString("hex")}`;
  db.profiles.set(userId, { id: userId, email, axis_api_key, kaggle_api_token: null, is_pro: false });

  res.status(201).json({ user: { id: userId, email }, axis_api_key });
});

app.post("/api/auth/signin", (req, res) => {
  const { email, password } = req.body;
  const user = db.users.get(email);
  if (!user || user.password !== password) return res.status(401).json({ error: "Identifiants invalides" });
  const profile = db.profiles.get(user.id);
  res.json({ user: { id: user.id, email }, profile });
});

// =========================================================================
// PROFIL & CONFIGURATION
// =========================================================================

app.get("/api/profile", (req, res) => {
  const profile = db.profiles.get(req.headers["x-user-id"]);
  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  res.json(profile);
});

app.post("/api/profile/update-kaggle", (req, res) => {
  const profile = db.profiles.get(req.headers["x-user-id"]);
  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  profile.kaggle_api_token = JSON.stringify(req.body.kaggle_api_token);
  db.profiles.set(profile.id, profile);
  res.json({ message: "Clé Kaggle enregistrée (chiffrée via pgsodium)", profile });
});

app.post("/api/profile/generate-key", (req, res) => {
  const profile = db.profiles.get(req.headers["x-user-id"]);
  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  profile.axis_api_key = `axis_${crypto.randomBytes(16).toString("hex")}`;
  db.profiles.set(profile.id, profile);
  res.json({ axis_api_key: profile.axis_api_key });
});

app.post("/api/profile/toggle-pro", (req, res) => {
  const profile = db.profiles.get(req.headers["x-user-id"]);
  if (!profile) return res.status(404).json({ error: "Profil introuvable" });
  profile.is_pro = !profile.is_pro;
  db.profiles.set(profile.id, profile);
  res.json({ is_pro: profile.is_pro });
});

// =========================================================================
// API DE LISTING DES MODÈLES AXIS
// =========================================================================

app.get("/v1/models", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing Authorization header" });
  const key = authHeader.substring(7);
  let found = false;
  for (const p of db.profiles.values()) { if (p.axis_api_key === key) { found = true; break; } }
  if (!found) return res.status(401).json({ error: "Invalid Axis API Key" });

  const models = Object.keys(AXIS_MODEL_POOLS).map((id) => ({
    id,
    object: "model",
    description: `Axis Mixture of Experts - Pool: [${AXIS_MODEL_POOLS[id].join(", ")}]`,
    owned_by: "axis-cloud",
    pool_size: AXIS_MODEL_POOLS[id].length,
    router: ROUTER_MODEL,
  }));

  res.json({ object: "list", data: models });
});

// =========================================================================
// PASSERELLE AXIS (COMPATIBLE OPENAI /v1/chat/completions)
// =========================================================================

app.post("/v1/chat/completions", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid Authorization header" });

  const axisApiKey = authHeader.substring(7);
  let profile = null;
  for (const p of db.profiles.values()) { if (p.axis_api_key === axisApiKey) { profile = p; break; } }
  if (!profile) return res.status(401).json({ error: "Invalid Axis API Key" });

  const { model, messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid or empty messages array" });
  }

  // Résoudre le pool : si le modèle n'est pas un profil axis-*, créer un pool ad hoc
  const resolvedModel = model || "axis-pro";
  const jobId = crypto.randomUUID();

  const job = {
    id: jobId,
    user_id: profile.id,
    model_target: resolvedModel,
    prompt_input: { messages },
    status: "en_attente",
    created_at: new Date().toISOString(),
    retries: 0,        // nombre de tentatives de relance
    max_retries: profile.is_pro ? 3 : 0, // relance auto uniquement en PRO
  };
  db.jobs.set(jobId, job);

  console.log(`[Queue] Job ${jobId} enfilé [modèle: ${resolvedModel}, user: ${profile.email}, pro: ${profile.is_pro}]`);

  res.status(202).json({
    status: "queued",
    job_id: jobId,
    check_status_url: `http://localhost:${PORT}/v1/jobs/status?id=${jobId}`,
    model_pool: AXIS_MODEL_POOLS[resolvedModel] || [resolvedModel],
    is_pro: profile.is_pro,
  });
});

// =========================================================================
// POLLING DE STATUT
// =========================================================================

app.get("/v1/jobs/status", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid Authorization header" });

  const axisApiKey = authHeader.substring(7);
  let profile = null;
  for (const p of db.profiles.values()) { if (p.axis_api_key === axisApiKey) { profile = p; break; } }
  if (!profile) return res.status(401).json({ error: "Invalid Axis API Key" });

  const jobId = req.query.id;
  if (!jobId) return res.status(400).json({ error: "Missing job ID parameter 'id'" });

  const job = db.jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.user_id !== profile.id) return res.status(403).json({ error: "Access denied to this job" });

  if (job.status === "completed") {
    res.json({
      job_id: job.id,
      status: "completed",
      model_used: job.model_used || job.model_target,
      choices: job.prompt_output?.choices || [],
    });
  } else if (job.status === "failed") {
    res.json({
      job_id: job.id,
      status: "failed",
      retries: job.retries,
      error: job.error_message || "Erreur interne de traitement",
    });
  } else {
    res.json({
      job_id: job.id,
      status: job.status === "en_attente" ? "queued" : "processing",
      retries: job.retries,
    });
  }
});

// =========================================================================
// WORKER DE FILE D'ATTENTE D'ARRIÈRE-PLAN
// Toutes les secondes, évalue les jobs en attente et les lance en respectant :
//   - Gratuit : max 1 job actif à la fois
//   - Pro     : max 3 jobs actifs, lissage de 4s entre chaque démarrage
// =========================================================================

// Garder trace du dernier démarrage par user (pour lissage PRO)
const lastStartTime = new Map(); // user_id -> timestamp

setInterval(async () => {
  const pendingJobs = Array.from(db.jobs.values()).filter((j) => j.status === "en_attente");
  if (pendingJobs.length === 0) return;

  for (const job of pendingJobs) {
    const profile = db.profiles.get(job.user_id);
    if (!profile) continue;

    const activeForUser = Array.from(db.jobs.values()).filter(
      (j) => j.user_id === job.user_id && j.status === "processing"
    ).length;

    if (!profile.is_pro) {
      // Mode Gratuit : max 1 job à la fois — break limit sans filtre
      if (activeForUser >= 1) {
        // On ne démarre pas, on laisse en file
        continue;
      }
    } else {
      // Mode Pro : max 3 jobs + lissage de 4s entre démarrages
      if (activeForUser >= 3) continue;

      const lastStart = lastStartTime.get(job.user_id) || 0;
      const elapsed = Date.now() - lastStart;
      if (elapsed < 4000) {
        // Pas encore 4s depuis le dernier démarrage → lissage, on attend
        continue;
      }
    }

    // Démarrer le job
    lastStartTime.set(job.user_id, Date.now());
    job.status = "processing";
    db.jobs.set(job.id, job);

    // Lancer l'inférence Kaggle en arrière-plan
    const promptText = job.prompt_input.messages[job.prompt_input.messages.length - 1].content;
    triggerKaggleProcess(job.id, profile, promptText, job.model_target);
  }
}, 1000);

// =========================================================================
// LOGIQUE D'INFÉRENCE KAGGLE AVEC ROUTEUR MOE
// =========================================================================

async function triggerKaggleProcess(jobId, profile, promptText, modelTarget) {
  const job = db.jobs.get(jobId);

  // Vérifier les credentials
  let credentials = null;
  if (profile.kaggle_api_token) {
    try { credentials = JSON.parse(profile.kaggle_api_token); } catch (_) {}
  }

  if (!credentials?.username || !credentials?.key) {
    job.status = "failed";
    job.error_message = "Clés API Kaggle manquantes ou invalides";
    db.jobs.set(jobId, job);
    return;
  }

  // MODE SIMULÉ
  if (MOCK_KAGGLE) {
    console.log(`[Kaggle Sim] Job ${jobId} → modèle: ${modelTarget}`);
    await new Promise((r) => setTimeout(r, 5000));

    // Simuler la sélection MoE
    const pool = AXIS_MODEL_POOLS[modelTarget] || [modelTarget];
    const chosenExpert = pool[Math.floor(Math.random() * pool.length)];

    job.status = "completed";
    job.model_used = chosenExpert;
    job.prompt_output = {
      choices: [{
        message: {
          role: "assistant",
          content: `[Sim MoE] Routeur a sélectionné "${chosenExpert}" dans le pool [${pool.join(", ")}].\n\nRéponse pour : "${promptText}"\n\nTraitement effectué à ${new Date().toLocaleTimeString()}.`,
        },
      }],
    };
    db.jobs.set(jobId, job);
    console.log(`[Kaggle Sim] Job ${jobId} complété (expert: ${chosenExpert}).`);
    return;
  }

  // MODE RÉEL
  const { username, key } = credentials;
  const kernelSlug = `axis-job-${jobId.slice(0, 8)}`;
  const pool = AXIS_MODEL_POOLS[modelTarget] || [modelTarget];
  const poolJson = JSON.stringify(pool);

  console.log(`[Kaggle Real] Job ${jobId} - user: ${username}, model: ${modelTarget}, pool: ${poolJson}`);

  // Script Python avec routeur MoE et fallback en cascade
  const pythonCode = `
import json
import os

prompt = """${promptText.replace(/"""/g, '\\"\\"\\"')}"""
model_target = "${modelTarget.replace(/"/g, '\\"')}"
axis_pool = ${poolJson}

output = None
chosen_expert = None

# =========================================================================
# ÉTAPE 1 : Kaggle Benchmarks SDK (quota gratuit Kaggle ~$10/jour)
# =========================================================================
try:
    print("=== Axis MoE Router : Tentative kaggle_benchmarks ===")
    import kaggle_benchmarks as kbench
    available_models = list(kbench.llms.keys())
    print(f"Modèles kbench disponibles : {available_models}")

    # Filtrer le pool sur les modèles réellement disponibles dans kbench
    eligible = [m for m in axis_pool if any(m.split('/')[-1].lower() in k.lower() for k in available_models)]
    print(f"Pool filtré (disponibles dans kbench) : {eligible}")

    if len(eligible) == 0:
        eligible = available_models[:2]  # fallback : premiers modèles disponibles
        print(f"Aucun modèle du pool dispo, utilisation des premiers : {eligible}")

    # Routeur : si plusieurs candidats, le premier modèle rapide choisit le meilleur
    if len(eligible) > 1:
        router_key = next((k for k in available_models if "flash" in k.lower() or "gemma-2-9b" in k.lower()), eligible[0])
        router_llm = kbench.llms[router_key]
        router_prompt = f"""Tu es un routeur d'experts IA. Voici une liste de modèles experts disponibles :
{json.dumps(eligible, indent=2)}

En fonction de ce prompt utilisateur, choisis le modèle le plus adapté et réponds UNIQUEMENT avec le nom exact du modèle (rien d'autre) :
"{prompt[:300]}"
"""
        chosen_expert = router_llm.prompt(router_prompt).strip()
        print(f"[Routeur MoE] Modèle choisi : {chosen_expert}")
        if chosen_expert not in eligible:
            chosen_expert = eligible[0]
            print(f"[Routeur MoE] Correction : modèle non reconnu, fallback vers {chosen_expert}")
    else:
        chosen_expert = eligible[0]
        print(f"[Routeur MoE] Un seul candidat : {chosen_expert}")

    # Exécution de l'expert sélectionné
    expert_key = next((k for k in available_models if chosen_expert.split('/')[-1].lower() in k.lower()), chosen_expert)
    expert_llm = kbench.llms[expert_key]
    response = expert_llm.prompt(prompt)
    output = {
        "choices": [{
            "message": {"role": "assistant", "content": response}
        }],
        "model_used": chosen_expert,
        "pool": axis_pool,
        "router": "kaggle_benchmarks"
    }
    print(f"[kbench] Réponse obtenue via {chosen_expert}")

except Exception as sdk_e:
    print(f"[kbench] Échec : {sdk_e}")

# =========================================================================
# ÉTAPE 2 : Fallback google-generativeai (API personnelle Gemini)
# =========================================================================
if not output:
    try:
        print("=== Axis Fallback : google-generativeai ===")
        import google.generativeai as genai

        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            try:
                from kaggle_secrets import UserSecretsClient
                api_key = UserSecretsClient().get_secret("GEMINI_API_KEY")
            except Exception as sec_e:
                print(f"[Secrets] {sec_e}")

        if api_key:
            genai.configure(api_key=api_key)

        # Choisir le modèle genai selon le profil
        if "pro" in model_target or "high" in model_target or "coding" in model_target:
            genai_model = "gemini-1.5-pro"
        elif "flash" in model_target or "low" in model_target:
            genai_model = "gemini-1.5-flash"
        else:
            genai_model = "gemini-1.5-flash"

        chosen_expert = f"genai/{genai_model}"
        print(f"[Fallback] Appel genai : {genai_model}")
        model_obj = genai.GenerativeModel(genai_model)
        response = model_obj.generate_content(prompt)
        output = {
            "choices": [{
                "message": {"role": "assistant", "content": response.text}
            }],
            "model_used": chosen_expert,
            "pool": axis_pool,
            "router": "google-generativeai-fallback"
        }
        print(f"[Fallback] Réponse obtenue via {genai_model}")

    except Exception as genai_e:
        print(f"[Fallback genai] Échec : {genai_e}")
        output = {
            "error": f"Tous les backends ont échoué. kbench: {str(sdk_e) if 'sdk_e' in locals() else 'N/A'}. genai: {str(genai_e)}"
        }

# Sauvegarder le résultat
with open("output.json", "w") as f:
    json.dump(output, f)
print("=== Inférence Axis complétée ===")
`;

  try {
    const authString = Buffer.from(`${username}:${key}`).toString("base64");
    const headers = { "Authorization": `Basic ${authString}`, "Content-Type": "application/json" };

    // Push du kernel Kaggle (CPU, pas de GPU pour économiser le quota 30h/sem)
    const pushRes = await fetch("https://www.kaggle.com/api/v1/kernels/push", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: `${username}/${kernelSlug}`,
        title: `Axis Job ${jobId.slice(0, 8)} [${modelTarget}]`,
        code: pythonCode,
        language: "python",
        kernelType: "script",
        isPrivate: true,
        enableGpu: false,   // CPU gratuit, préserve le quota GPU 30h/sem
        enableTpu: false,
        enableInternet: true,
      }),
    });

    if (!pushRes.ok) {
      const errTxt = await pushRes.text();
      throw new Error(`Kaggle Push Error (${pushRes.status}): ${errTxt}`);
    }

    console.log(`[Kaggle Real] Kernel "${kernelSlug}" poussé avec succès.`);

    // Polling du statut Kaggle (max 5 min)
    let completed = false;
    let pollCount = 0;
    const maxPolls = 60; // 60 x 5s = 5 minutes

    while (pollCount < maxPolls && !completed) {
      await new Promise((r) => setTimeout(r, 5000));
      pollCount++;

      const statusRes = await fetch(
        `https://www.kaggle.com/api/v1/kernels/status?kernelRef=${username}/${kernelSlug}`,
        { headers }
      );
      if (!statusRes.ok) continue;

      const statusData = await statusRes.json();
      const kStatus = statusData.status;
      console.log(`[Kaggle Real] Polling Job ${jobId} (${pollCount}/${maxPolls}) → ${kStatus}`);

      if (kStatus === "complete") {
        completed = true;
        // Récupérer l'output
        const outputRes = await fetch(
          `https://www.kaggle.com/api/v1/kernels/output?kernelRef=${username}/${kernelSlug}`,
          { headers }
        );
        if (!outputRes.ok) throw new Error(`Impossible de lire l'output Kaggle (${outputRes.status})`);

        const outputData = await outputRes.json();
        const outputFile = outputData.files?.find((f) => f.name === "output.json");
        if (!outputFile) throw new Error("output.json manquant dans les fichiers Kaggle");

        const downloadRes = await fetch(outputFile.url);
        const result = await downloadRes.json();
        if (result.error) throw new Error(result.error);

        job.status = "completed";
        job.model_used = result.model_used || modelTarget;
        job.prompt_output = result;
        db.jobs.set(jobId, job);
        console.log(`[Kaggle Real] Job ${jobId} ✓ (expert: ${job.model_used})`);

      } else if (kStatus === "error") {
        throw new Error(`Erreur noyau Kaggle : ${statusData.failureMessage || "Inconnu"}`);
      }
    }

    if (!completed) throw new Error("Timeout Kaggle (5 min) dépassé");

  } catch (err) {
    console.error(`[Kaggle Error] Job ${jobId}: ${err.message}`);

    // RELANCE AUTOMATIQUE pour les utilisateurs PRO
    if (profile.is_pro && job.retries < job.max_retries) {
      job.retries += 1;
      job.status = "en_attente"; // Re-enfile pour le worker
      job.error_message = `Tentative ${job.retries}/${job.max_retries} : ${err.message}`;
      db.jobs.set(jobId, job);
      console.log(`[Auto-Relance PRO] Job ${jobId} re-enfilé (tentative ${job.retries}/${job.max_retries})`);
    } else {
      job.status = "failed";
      job.error_message = err.message;
      db.jobs.set(jobId, job);
    }
  }
}

// =========================================================================
// DÉMARRAGE DU SERVEUR
// =========================================================================
app.listen(PORT, () => {
  console.log(`\n🚀 Serveur Axis Simulator démarré sur http://localhost:${PORT}`);
  console.log(`🤖 Mode Kaggle     : ${MOCK_KAGGLE ? "SIMULÉ (MOCK_KAGGLE=true)" : "RÉEL (MOCK_KAGGLE=false)"}`);
  console.log(`🧠 Routeur MoE     : ${ROUTER_MODEL}`);
  console.log(`📦 Pools disponibles : ${Object.keys(AXIS_MODEL_POOLS).join(", ")}\n`);
});
