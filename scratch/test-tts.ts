import { synthesizeAudio } from "../artifacts/api-server/src/lib/tts";
import fs from "fs";

async function run() {
  try {
    console.log("Synthesizing audio...");
    const buffer = await synthesizeAudio("Hola, esto es una prueba de audio.");
    fs.writeFileSync("test.mp3", buffer);
    console.log("Audio saved to test.mp3. Size:", buffer.length);
  } catch (err) {
    console.error("Failed to synthesize audio:", err);
  }
}

run();
