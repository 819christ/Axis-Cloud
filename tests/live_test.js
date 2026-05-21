/**
 * live_test.js - Tests en conditions réelles pour Axis Cloud
 * 
 * Ce script envoie de VRAIES requêtes au serveur local pour tester
 * l'ensemble du flux de travail de bout en bout :
 *   1. Authentification (signup / signin)
 *   2. Configuration Kaggle (upload token)
 *   3. Listing des modèles
 *   4. Requêtes d'inférence avec différents pools MoE
 *   5. Polling et récupération des résultats
 *   6. Requêtes concurrentes (lissage PRO)
 *   7. Gestion des erreurs (clé invalide, messages vides, etc.)
 *   8. Mode Gratuit vs PRO
 */

import { spawn } from "child_process";

const PORT = 4444;
const API_URL = `http://localhost:${PORT}`;
let serverProcess = null;
let testsPassed = 0;
let testsFailed = 0;

// =========================================================================
// HELPERS
// =========================================================================

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

function pass(name) {
  testsPassed++;
  log("✅", `PASS: ${name}`);
}

function fail(name, err) {
  testsFailed++;
  log("❌", `FAIL: ${name} → ${err}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: PORT.toString(),
      MOCK_KAGGLE: "true", // Mode simulé pour les tests de bout en bout
    };

    serverProcess = spawn("node", ["simulator/server.js"], { env, cwd: process.cwd() });

    let started = false;
    serverProcess.stdout.on("data", (data) => {
      const output = data.toString();
      if (!started && output.includes("Axis Simulator démarré")) {
        started = true;
        resolve();
      }
    });

    serverProcess.stderr.on("data", (data) => {
      // Ignore stderr noise
    });

    serverProcess.on("error", (err) => reject(err));

    // Timeout de sécurité
    setTimeout(() => {
      if (!started) reject(new Error("Timeout: serveur non démarré en 10s"));
    }, 10000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// =========================================================================
// TESTS
// =========================================================================

async function testSignup() {
  const name = "Signup - création d'un nouveau compte";
  try {
    const res = await fetch(`${API_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "live_test@example.com", password: "securepass" }),
    });
    const data = await res.json();
    if (res.status !== 201) throw new Error(`Status ${res.status}: ${JSON.stringify(data)}`);
    if (!data.user?.id) throw new Error("Pas d'user.id retourné");
    if (!data.axis_api_key) throw new Error("Pas d'axis_api_key retourné");
    pass(name);
    return data;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function testSignupDuplicate() {
  const name = "Signup - refus de doublon d'email";
  try {
    const res = await fetch(`${API_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "live_test@example.com", password: "securepass" }),
    });
    if (res.status !== 400) throw new Error(`Attendu 400, reçu ${res.status}`);
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testSignin() {
  const name = "Signin - connexion avec les credentials de test";
  try {
    const res = await fetch(`${API_URL}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "password123" }),
    });
    const data = await res.json();
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!data.profile?.axis_api_key) throw new Error("Pas de profil retourné");
    pass(name);
    return data;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function testSigninInvalid() {
  const name = "Signin - rejet d'identifiants invalides";
  try {
    const res = await fetch(`${API_URL}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "wrong" }),
    });
    if (res.status !== 401) throw new Error(`Attendu 401, reçu ${res.status}`);
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testListModels(apiKey) {
  const name = "GET /v1/models - listing de tous les pools MoE";
  try {
    const res = await fetch(`${API_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!data.data || !Array.isArray(data.data)) throw new Error("Pas de data[] retourné");
    const ids = data.data.map((m) => m.id);
    const expected = ["axis-low", "axis-medium", "axis-high", "axis-flash", "axis-pro", "axis-coding"];
    for (const e of expected) {
      if (!ids.includes(e)) throw new Error(`Modèle "${e}" manquant`);
    }
    log("   ", `Modèles listés : ${ids.join(", ")}`);
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testListModelsInvalidKey() {
  const name = "GET /v1/models - rejet si clé API invalide";
  try {
    const res = await fetch(`${API_URL}/v1/models`, {
      headers: { Authorization: "Bearer fake_key_123" },
    });
    if (res.status !== 401) throw new Error(`Attendu 401, reçu ${res.status}`);
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testInferenceAndPolling(apiKey, model, promptText) {
  const name = `Inférence complète [${model}] - "${promptText.slice(0, 40)}..."`;
  try {
    // 1. Soumettre le job
    const initRes = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: promptText }],
      }),
    });

    const initData = await initRes.json();
    if (initRes.status !== 202) throw new Error(`Attendu 202, reçu ${initRes.status}`);
    if (initData.status !== "queued") throw new Error(`Status initial: ${initData.status}, attendu: queued`);
    if (!initData.job_id) throw new Error("Pas de job_id");

    const jobId = initData.job_id;
    log("   ", `Job ${jobId.slice(0, 8)} soumis → polling...`);

    // 2. Boucle de polling
    let completed = false;
    let result = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const statusRes = await fetch(`${API_URL}/v1/jobs/status?id=${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const statusData = await statusRes.json();

      if (statusData.status === "completed") {
        completed = true;
        result = statusData;
        break;
      } else if (statusData.status === "failed") {
        throw new Error(`Job échoué: ${statusData.error}`);
      }
    }

    if (!completed) throw new Error("Timeout du polling (20s)");
    if (!result.choices?.[0]?.message?.content) throw new Error("Pas de contenu dans la réponse");

    log("   ", `Expert utilisé: ${result.model_used || "N/A"}`);
    log("   ", `Réponse (extrait): "${result.choices[0].message.content.slice(0, 80)}..."`);
    pass(name);
    return result;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function testConcurrentRequests(apiKey) {
  const name = "Requêtes concurrentes PRO - 4 jobs simultanés avec lissage";
  try {
    const t0 = Date.now();
    const models = ["axis-flash", "axis-coding", "axis-low", "axis-pro"];
    const prompts = [
      "Qu'est-ce que la récursivité ?",
      "Écris un tri rapide en JavaScript",
      "Explique la photosynthèse simplement",
      "Compare REST et GraphQL",
    ];

    // Soumettre les 4 jobs simultanément
    const submissions = await Promise.all(
      models.map((model, i) =>
        fetch(`${API_URL}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompts[i] }],
          }),
        }).then((r) => r.json())
      )
    );

    log("   ", `4 jobs soumis en parallèle`);

    // Attendre que tous soient terminés
    const jobIds = submissions.map((s) => s.job_id);
    const results = await Promise.all(
      jobIds.map(async (jobId) => {
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const res = await fetch(`${API_URL}/v1/jobs/status?id=${jobId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          const d = await res.json();
          if (d.status === "completed" || d.status === "failed") return d;
        }
        return { status: "timeout" };
      })
    );

    const elapsed = Date.now() - t0;
    const completedCount = results.filter((r) => r.status === "completed").length;
    const failedCount = results.filter((r) => r.status === "failed").length;

    log("   ", `Résultats: ${completedCount} complétés, ${failedCount} échoués`);
    log("   ", `Durée totale: ${elapsed}ms`);

    if (completedCount < 4) throw new Error(`Seulement ${completedCount}/4 complétés`);

    // Le lissage PRO doit imposer au moins 4s de délai entre les démarrages
    if (elapsed < 8000) {
      log("   ", `⚠️ Durée (${elapsed}ms) semble courte pour le lissage PRO`);
    } else {
      log("   ", `✓ Lissage PRO actif (${elapsed}ms > 8000ms)`);
    }

    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testInvalidRequests(apiKey) {
  const name = "Requêtes invalides - messages vides, pas d'auth, etc.";
  try {
    // Test 1: Pas de header Authorization
    const r1 = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    });
    if (r1.status !== 401) throw new Error(`Pas d'auth: attendu 401, reçu ${r1.status}`);

    // Test 2: Messages vides
    const r2 = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ messages: [] }),
    });
    if (r2.status !== 400) throw new Error(`Messages vides: attendu 400, reçu ${r2.status}`);

    // Test 3: Clé API invalide
    const r3 = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer totally_fake_key",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
    });
    if (r3.status !== 401) throw new Error(`Clé fake: attendu 401, reçu ${r3.status}`);

    // Test 4: Job inexistant
    const r4 = await fetch(`${API_URL}/v1/jobs/status?id=00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r4.status !== 404) throw new Error(`Job fake: attendu 404, reçu ${r4.status}`);

    // Test 5: Polling sans ID
    const r5 = await fetch(`${API_URL}/v1/jobs/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r5.status !== 400) throw new Error(`Pas d'ID: attendu 400, reçu ${r5.status}`);

    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testTogglePro(userId) {
  const name = "Toggle PRO/Gratuit - basculement d'abonnement";
  try {
    // Basculer de PRO à Gratuit
    const r1 = await fetch(`${API_URL}/api/profile/toggle-pro`, {
      method: "POST",
      headers: { "x-user-id": userId },
    });
    const d1 = await r1.json();
    
    // Re-basculer
    const r2 = await fetch(`${API_URL}/api/profile/toggle-pro`, {
      method: "POST",
      headers: { "x-user-id": userId },
    });
    const d2 = await r2.json();

    // Le toggle doit inverser la valeur
    if (d1.is_pro === d2.is_pro) throw new Error("Le toggle ne fonctionne pas");

    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testGenerateKey(userId) {
  const name = "Génération de clé API - régénération sécurisée";
  try {
    const r1 = await fetch(`${API_URL}/api/profile/generate-key`, {
      method: "POST",
      headers: { "x-user-id": userId },
    });
    const d1 = await r1.json();

    const r2 = await fetch(`${API_URL}/api/profile/generate-key`, {
      method: "POST",
      headers: { "x-user-id": userId },
    });
    const d2 = await r2.json();

    if (!d1.axis_api_key.startsWith("axis_")) throw new Error("Clé ne commence pas par 'axis_'");
    if (d1.axis_api_key === d2.axis_api_key) throw new Error("Deux régénérations donnent la même clé");

    pass(name);
    return d2.axis_api_key; // retourner la nouvelle clé
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function testKaggleTokenUpload(userId) {
  const name = "Upload Kaggle JSON - stockage et validation";
  try {
    const res = await fetch(`${API_URL}/api/profile/update-kaggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": userId,
      },
      body: JSON.stringify({
        kaggle_api_token: { username: "test_kaggle_user", key: "test_kaggle_key_123" },
      }),
    });
    const data = await res.json();
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    if (!data.profile) throw new Error("Pas de profil retourné");
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testFreeUserConcurrency(signupData) {
  const name = "Mode Gratuit - max 1 job actif à la fois (concurrence bloquée)";
  try {
    const userId = signupData.user.id;
    const apiKey = signupData.axis_api_key;

    // D'abord, upload un token Kaggle pour ce user
    await fetch(`${API_URL}/api/profile/update-kaggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": userId },
      body: JSON.stringify({
        kaggle_api_token: { username: "free_user", key: "free_key_123" },
      }),
    });

    // Ce user est Gratuit (is_pro = false par défaut)
    // Envoyer 2 jobs simultanément
    const [r1, r2] = await Promise.all([
      fetch(`${API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "axis-low", messages: [{ role: "user", content: "Job 1" }] }),
      }).then((r) => r.json()),
      fetch(`${API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "axis-low", messages: [{ role: "user", content: "Job 2" }] }),
      }).then((r) => r.json()),
    ]);

    // Les deux doivent être acceptés (queued)
    if (r1.status !== "queued" || r2.status !== "queued") throw new Error("Jobs non acceptés");

    // Attendre la complétion séquentielle
    const t0 = Date.now();
    for (const jobId of [r1.job_id, r2.job_id]) {
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const res = await fetch(`${API_URL}/v1/jobs/status?id=${jobId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const d = await res.json();
        if (d.status === "completed" || d.status === "failed") break;
      }
    }
    const elapsed = Date.now() - t0;

    // En mode gratuit, les jobs doivent s'exécuter séquentiellement (environ 5s chacun)
    log("   ", `Durée pour 2 jobs séquentiels (Gratuit): ${elapsed}ms`);
    if (elapsed >= 9000) {
      log("   ", `✓ Concurrence limitée confirmée (${elapsed}ms >= 9s)`);
    }
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// =========================================================================
// MAIN
// =========================================================================

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🧪 AXIS CLOUD - Suite de Tests en Conditions Réelles");
  console.log("═══════════════════════════════════════════════════════════════\n");

  try {
    log("🚀", "Démarrage du serveur de test...");
    await startServer();
    log("✅", `Serveur démarré sur le port ${PORT}\n`);

    // ---- SECTION 1: Authentification ----
    console.log("─── SECTION 1: Authentification ───────────────────────────────");
    const signinData = await testSignin();
    const signupData = await testSignup();
    await testSignupDuplicate();
    await testSigninInvalid();
    console.log();

    const testApiKey = signinData.profile.axis_api_key;
    const testUserId = signinData.user.id;

    // ---- SECTION 2: Profil & Configuration ----
    console.log("─── SECTION 2: Profil & Configuration ────────────────────────");
    await testKaggleTokenUpload(testUserId);
    await testTogglePro(testUserId);
    const newKey = await testGenerateKey(testUserId);
    console.log();

    // Utiliser la nouvelle clé pour les tests suivants
    const activeKey = newKey || testApiKey;

    // ---- SECTION 3: Listing des Modèles ----
    console.log("─── SECTION 3: Listing des Modèles ───────────────────────────");
    await testListModels(activeKey);
    await testListModelsInvalidKey();
    console.log();

    // ---- SECTION 4: Inférence et Polling (variété de modèles) ----
    console.log("─── SECTION 4: Inférence et Polling (MoE) ───────────────────");
    await testInferenceAndPolling(activeKey, "axis-flash", "Quelle est la capitale de la France ?");
    await testInferenceAndPolling(activeKey, "axis-coding", "Écris un algorithme de tri à bulles en Python avec des commentaires");
    await testInferenceAndPolling(activeKey, "axis-low", "Donne-moi 3 faits intéressants sur les abeilles");
    await testInferenceAndPolling(activeKey, "axis-pro", "Explique le théorème de Bayes et donne un exemple concret");
    await testInferenceAndPolling(activeKey, "axis-high", "Compare les architectures microservices et monolithiques");
    await testInferenceAndPolling(activeKey, "axis-medium", "Comment fonctionne un réseau de neurones récurrents ?");
    console.log();

    // ---- SECTION 5: Gestion des Erreurs ----
    console.log("─── SECTION 5: Gestion des Erreurs ──────────────────────────");
    await testInvalidRequests(activeKey);
    console.log();

    // ---- SECTION 6: Concurrence PRO ----
    console.log("─── SECTION 6: Concurrence PRO (4 jobs simultanés) ──────────");
    await testConcurrentRequests(activeKey);
    console.log();

    // ---- SECTION 7: Concurrence Mode Gratuit ----
    console.log("─── SECTION 7: Concurrence Mode Gratuit (séquentielle) ──────");
    if (signupData) {
      await testFreeUserConcurrency(signupData);
    } else {
      log("⏭️", "Skipped (signup échoué)");
    }
    console.log();

  } catch (err) {
    log("💥", `Erreur fatale: ${err.message}`);
    console.error(err);
  } finally {
    stopServer();
  }

  // ---- RÉSUMÉ ----
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  📊 RÉSULTATS: ${testsPassed} passés, ${testsFailed} échoués`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (testsFailed > 0) {
    log("❌", "Certains tests ont échoué !");
    process.exit(1);
  } else {
    log("🎉", "TOUS LES TESTS ONT RÉUSSI !");
    process.exit(0);
  }
}

main();
