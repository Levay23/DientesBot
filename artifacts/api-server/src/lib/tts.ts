import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { logger } from "./logger";

export async function synthesizeAudio(text: string): Promise<Buffer> {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata("es-CO-SalomeNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    // We can add SSML parameters to make it sound more natural.
    // However, edge-tts handles plain text quite well.
    // If we wanted to adjust rate or pitch, we'd use SSML or the library's features.
    
    // The toStream function returns a readable stream.
    const stream = tts.toStream(text);
    
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", (err) => {
        logger.error({ err }, "Error in TTS stream");
        reject(err);
      });
    });
  } catch (error) {
    logger.error({ error }, "Error synthesizing audio");
    throw error;
  }
}
