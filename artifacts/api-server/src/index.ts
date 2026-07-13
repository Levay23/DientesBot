import app from "./app";
import { logger } from "./lib/logger";
import { startWhatsApp } from "./lib/whatsapp";
import { runStartupSeed } from "./lib/startup-seed";
import { startAutomationsEngine } from "./lib/automations-engine";
import { syncAllConversationsWithPatients } from "./lib/conversation-patient-sync";
import { getWAState } from "./lib/whatsapp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import fs from "fs";

// Configure ffmpeg globally for Baileys to convert audio to OGG Opus
if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
} else {
  logger.warn("ffmpeg-static binary not found, falling back to system ffmpeg");
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Seed DB (admin user + AI knowledge) on every startup
  runStartupSeed().catch((err) => {
    logger.error({ err }, "Error en startup seed");
  });

  setTimeout(() => {
    const wa = getWAState(1);
    syncAllConversationsWithPatients(wa.phone, 1).catch((err) => {
      logger.error({ err }, "Error sincronizando conversaciones con pacientes");
    });
  }, 15000);

  // Iniciar WhatsApp Web (Baileys) en background — sesión del admin (user 1)
  startWhatsApp(1).catch((err) => {
    logger.error({ err }, "Error iniciando WhatsApp");
  });

  // Iniciar motor de automatizaciones
  startAutomationsEngine();
});
