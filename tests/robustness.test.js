import { spawn } from "child_process";
import assert from "assert";

const PORT = 4000; // Port temporaire pour les tests
let serverProcess = null;

// Helper pour lancer le serveur de simulation
function startServer() {
  return new Promise((resolve, reject) => {
    // Configurer le port de test et forcer le mock Kaggle pour la rapidité des tests
    const env = { 
      ...process.env, 
      PORT: PORT.toString(), 
      MOCK_KAGGLE: "true" 
    };

    serverProcess = spawn("node", ["simulator/server.js"], { env });

    serverProcess.stdout.on("data", (data) => {
      const output = data.toString();
      if (output.includes("Axis Simulator démarré")) {
        resolve();
      }
    });

    serverProcess.stderr.on("data", (data) => {
      console.error(`[Server Error]: ${data}`);
    });

    serverProcess.on("error", (err) => {
      reject(err);
    });
  });
}

// Helper pour arrêter le serveur de simulation
function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
  }
}

// Fonction de test principale
async function runTests() {
  console.log("🚀 Lancement des tests de robustesse et de conformité pour Axis...\n");

  try {
    await startServer();
    console.log("✅ Serveur de test démarré sur le port " + PORT);

    const API_URL = `http://localhost:${PORT}`;
    const testApiKey = "axis_test_key_abc123"; // Clé préconfigurée dans le simulateur

    // Test 1: Authentification invalide
    console.log("\n🧪 Test 1 : Authentification invalide...");
    const res1 = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer key_invalide_123"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Test" }]
      })
    });
    assert.strictEqual(res1.status, 401, "Devrait renvoyer 401 pour une clé invalide");
    const data1 = await res1.json();
    assert.ok(data1.error.includes("Invalid Axis API Key"), "Le message d'erreur doit être explicite");
    console.log("➡️ Test 1 validé !");

    // Test 2: Requête d'inférence asynchrone (202 Accepted)
    console.log("\n🧪 Test 2 : Initialisation asynchrone (202 Accepted)...");
    const res2 = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${testApiKey}`
      },
      body: JSON.stringify({
        model: "axis-pro",
        messages: [{ role: "user", content: "Donne-moi une blague." }]
      })
    });
    assert.strictEqual(res2.status, 202, "L'initialisation réussie doit renvoyer 202");
    const data2 = await res2.json();
    assert.strictEqual(data2.status, "queued", "Le statut de démarrage doit être 'queued'");
    assert.ok(data2.job_id, "Doit renvoyer un 'job_id' valide");
    assert.ok(data2.check_status_url.includes(data2.job_id), "L'URL de polling doit inclure l'ID de tâche");
    console.log("➡️ Test 2 validé !");

    const jobId = data2.job_id;

    // Test 3: Vérification du cycle de Polling (queued/processing -> completed)
    console.log("\n🧪 Test 3 : Cycle de Polling (queued/processing -> completed)...");
    let completed = false;
    let attempts = 0;
    
    while (!completed && attempts < 10) {
      attempts++;
      const resStatus = await fetch(`${API_URL}/v1/jobs/status?id=${jobId}`, {
        headers: { "Authorization": `Bearer ${testApiKey}` }
      });
      assert.strictEqual(resStatus.status, 200, "Le statut doit répondre 200 OK");
      const statusData = await resStatus.json();
      
      console.log(`   Tentative de polling #${attempts} - Statut : ${statusData.status}`);
      
      if (statusData.status === "completed") {
        completed = true;
        assert.ok(Array.isArray(statusData.choices), "La réponse finalisée doit contenir 'choices'");
        assert.ok(statusData.choices[0].message.content, "La réponse doit contenir un contenu textuel");
        console.log(`   [Réponse reçue] : ${statusData.choices[0].message.content}`);
      } else {
        assert.ok(statusData.status === "queued" || statusData.status === "processing", "Le statut intermédiaire doit être queued ou processing");
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    assert.ok(completed, "Le job devrait être complété dans les temps");
    console.log("➡️ Test 3 validé !");

    // Test 4: Parallélisme et Limitation du débit (Rate Limiting / Lissage Pro)
    console.log("\n🧪 Test 4 : Parallélisme et régulation (lissage des requêtes concurrentes)...");
    const t0 = Date.now();
    
    // Envoyer 3 requêtes simultanément
    console.log("   Envoi de 3 requêtes simultanées en mode PRO...");
    const promises = Array.from({ length: 3 }).map(() => 
      fetch(`${API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${testApiKey}`
        },
        body: JSON.stringify({
          model: "axis-pro",
          messages: [{ role: "user", content: "Prompt concurrent" }]
        })
      }).then(r => r.json())
    );

    const jobResults = await Promise.all(promises);
    assert.strictEqual(jobResults.length, 3, "Doit accepter les 3 jobs");

    // Attendre que les 3 soient terminés et mesurer le temps total
    console.log("   Attente de la fin de toutes les tâches concurrentes...");
    const pollPromises = jobResults.map(async (job) => {
      let done = false;
      while (!done) {
        const res = await fetch(`${API_URL}/v1/jobs/status?id=${job.job_id}`, {
          headers: { "Authorization": `Bearer ${testApiKey}` }
        });
        const d = await res.json();
        if (d.status === "completed") {
          done = true;
        } else {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    });

    await Promise.all(pollPromises);
    const duration = Date.now() - t0;
    
    console.log(`   Durée totale d'exécution pour 3 jobs concurrents : ${duration}ms`);
    // Le lissage PRO doit imposer un délai de 4 secondes pour le 3ème job actif, 
    // donc la durée totale doit être d'au moins 5 secondes (délai d'exécution) + 4 secondes (lissage) = ~9 secondes.
    assert.ok(duration > 8000, "Le lissage PRO aurait dû retarder l'exécution d'au moins 8000ms");
    console.log("➡️ Test 4 validé (lissage PRO actif) !");

    // Test 5: Résilience et gestion d'erreur robuste (Kaggle crash simulation)
    console.log("\n🧪 Test 5 : Résilience (Échec contrôlé)...");
    
    // Créer un utilisateur sans clés d'API valides pour provoquer un échec immédiat
    const signupRes = await fetch(`${API_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "error@example.com", password: "password" })
    });
    const signupData = await signupRes.json();
    const errorUserApiKey = signupData.axis_api_key;

    // Soumettre un job
    const failJobRes = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${errorUserApiKey}`
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Sera en échec" }]
      })
    });
    const failJobData = await failJobRes.json();
    const failJobId = failJobData.job_id;

    // Attendre l'échec et vérifier la transition de statut propre
    let failConfirmed = false;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const res = await fetch(`${API_URL}/v1/jobs/status?id=${failJobId}`, {
        headers: { "Authorization": `Bearer ${errorUserApiKey}` }
      });
      const d = await res.json();
      if (d.status === "failed") {
        failConfirmed = true;
        assert.ok(d.error, "Le statut 'failed' doit retourner le message d'erreur explicatif");
        console.log(`   Message d'erreur capturé : "${d.error}"`);
        break;
      }
    }
    assert.ok(failConfirmed, "La tâche doit passer proprement en statut 'failed'");
    console.log("➡️ Test 5 validé !");

    console.log("\n🎉 TOUS LES TESTS DE ROBUSTESSE ONT RÉUSSI AVEC SUCCÈS ! 🎉");
    stopServer();
    process.exit(0);

  } catch (err) {
    console.error("\n❌ ÉCHEC D'UN TEST :");
    console.error(err);
    stopServer();
    process.exit(1);
  }
}

runTests();
