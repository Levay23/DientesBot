import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { PassThrough } from "stream";
import fs from "fs";
import { logger } from "./logger";

if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
} else {
  logger.warn("ffmpeg-static binary not found, will attempt to use system ffmpeg if available");
}

export async function synthesizeAudio(text: string): Promise<{ buffer: Buffer; mimetype: string }> {
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata("es-CO-SalomeNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    
    // Slightly increased rate (+6%) for a more agile but natural conversation
    const { audioStream } = tts.toStream(text, { rate: "+6%", pitch: "+0%" });
    
    const mp3Buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      audioStream.on("end", () => resolve(Buffer.concat(chunks)));
      audioStream.on("error", reject);
    });

    try {
      const oggBuffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const outStream = new PassThrough();
        outStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        outStream.on("end", () => resolve(Buffer.concat(chunks)));
        outStream.on("error", reject);

        const inputStream = new PassThrough();
        inputStream.end(mp3Buffer);

        ffmpeg(inputStream)
          .audioCodec("libopus")
          .toFormat("ogg")
          .on("error", (err) => {
            logger.warn({ err }, "FFmpeg conversion failed, falling back to raw MP3");
            reject(err);
          })
          .pipe(outStream, { end: true });
      });

      return { buffer: oggBuffer, mimetype: "audio/ogg; codecs=opus" };
    } catch (ffmpegErr) {
      // If ffmpeg fails, return the original MP3. WhatsApp Web can play it, 
      // and we avoid the bot not responding at all.
      return { buffer: mp3Buffer, mimetype: "audio/mpeg" };
    }
  } catch (error) {
    logger.error({ error }, "Critical error in synthesizeAudio");
    throw error;
  }
}
