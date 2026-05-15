import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { logger } from "./logger";

export async function synthesizeAudio(text: string): Promise<Buffer> {
  try {
    const tts = new MsEdgeTTS();
    // Use the highest quality MP3 output from Microsoft as the source
    await tts.setMetadata("es-CO-SalomeNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    // Adjust rate and pitch to sound more natural and fluent (human-like)
    // +15% rate makes it speak slightly faster, avoiding the slow robotic cadence
    const { audioStream } = tts.toStream(text, { rate: "+15%", pitch: "+2%" });
    
    const chunks: Buffer[] = [];
    const outStream = new PassThrough();

    return new Promise((resolve, reject) => {
      outStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      outStream.on("end", () => resolve(Buffer.concat(chunks)));
      outStream.on("error", (err) => {
        logger.error({ err }, "Error in TTS pass-through stream");
        reject(err);
      });

      // Pipe the MP3 stream into FFmpeg to convert it to WhatsApp's native OGG Opus format
      ffmpeg(audioStream)
        .audioCodec("libopus")
        .toFormat("ogg")
        .on("error", (err) => {
          logger.error({ err }, "FFmpeg error during TTS conversion to OGG Opus");
          reject(err);
        })
        .pipe(outStream, { end: true });
    });
  } catch (error) {
    logger.error({ error }, "Error synthesizing and converting audio");
    throw error;
  }
}
