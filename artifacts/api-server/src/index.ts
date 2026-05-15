import app from "./app";
import { logger } from "./lib/logger";
import { startWhatsApp } from "./lib/whatsapp";
import { runStartupSeed } from "./lib/startup-seed";
import { startAutomationsEngine } from "./lib/automations-engine";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

// Configure ffmpeg globally for Baileys to convert audio to OGG Opus
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
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

  // Iniciar WhatsApp Web (Baileys) en background
  startWhatsApp().catch((err) => {
    logger.error({ err }, "Error iniciando WhatsApp");
  });

  // Iniciar motor de automatizaciones
  startAutomationsEngine();
});
