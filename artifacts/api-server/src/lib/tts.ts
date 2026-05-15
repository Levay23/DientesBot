import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { logger } from "./logger";

export async function synthesizeAudio(text: string): Promise<Buffer> {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata("es-CO-SalomeNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    // We can add SSML parameters to make it sound more natural.
    // However, edge-tts handles plain text quite well.
    // If we wanted to adjust rate or pitch, we'd use SSML or the library's features.
    
    // The toStream function returns an object with audioStream
    const { audioStream } = tts.toStream(text);
    
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      audioStream.on("end", () => resolve(Buffer.concat(chunks)));
      audioStream.on("error", (err) => {
        logger.error({ err }, "Error in TTS stream");
        reject(err);
      });
    });
  } catch (error) {
    logger.error({ error }, "Error synthesizing audio");
    throw error;
  }
}
