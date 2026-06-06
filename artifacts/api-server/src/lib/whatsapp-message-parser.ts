import { downloadMediaMessage, proto, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import { logger } from "./logger";
import { transcribeAudio } from "./groq";

export type ParsedMessageType = "text" | "image" | "audio" | "video" | "document" | "sticker";

export type ParsedWhatsAppMessage = {
  text: string;
  messageType: ParsedMessageType;
  mediaMimeType?: string;
  mediaData?: string;
  wasAudio: boolean;
};

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

async function downloadMedia(
  msg: proto.IWebMessageInfo,
  sock: WASocket | null,
): Promise<Buffer | null> {
  if (!sock) return null;
  try {
    const buffer = await downloadMediaMessage(msg as WAMessage, "buffer", {}, {
      logger: logger as any,
      reuploadRequest: sock.updateMediaMessage as any,
    });
    const buf = buffer as Buffer;
    if (buf.length > MAX_MEDIA_BYTES) {
      logger.warn({ size: buf.length }, "Media demasiado grande, omitiendo descarga");
      return null;
    }
    return buf;
  } catch (err) {
    logger.error({ err }, "Error descargando media de WhatsApp");
    return null;
  }
}

export async function parseWhatsAppMessage(
  msg: proto.IWebMessageInfo,
  sock: WASocket | null,
  options?: { transcribeAudio?: boolean },
): Promise<ParsedWhatsAppMessage | null> {
  const m = msg.message;
  if (!m) return null;

  if (m.conversation?.trim()) {
    return { text: m.conversation.trim(), messageType: "text", wasAudio: false };
  }

  if (m.extendedTextMessage?.text?.trim()) {
    return { text: m.extendedTextMessage.text.trim(), messageType: "text", wasAudio: false };
  }

  if (m.imageMessage) {
    const caption = m.imageMessage.caption?.trim() ?? "";
    const buffer = await downloadMedia(msg, sock);
    return {
      text: caption || "📷 Imagen",
      messageType: "image",
      mediaMimeType: m.imageMessage.mimetype ?? "image/jpeg",
      mediaData: buffer?.toString("base64"),
      wasAudio: false,
    };
  }

  if (m.stickerMessage) {
    const buffer = await downloadMedia(msg, sock);
    return {
      text: "🎭 Sticker",
      messageType: "sticker",
      mediaMimeType: m.stickerMessage.mimetype ?? "image/webp",
      mediaData: buffer?.toString("base64"),
      wasAudio: false,
    };
  }

  if (m.videoMessage) {
    const caption = m.videoMessage.caption?.trim() ?? "";
    const buffer = await downloadMedia(msg, sock);
    return {
      text: caption || "🎬 Video",
      messageType: "video",
      mediaMimeType: m.videoMessage.mimetype ?? "video/mp4",
      mediaData: buffer?.toString("base64"),
      wasAudio: false,
    };
  }

  if (m.documentMessage) {
    const fileName = m.documentMessage.fileName ?? m.documentMessage.title ?? "Documento";
    const caption = m.documentMessage.caption?.trim();
    const buffer = await downloadMedia(msg, sock);
    return {
      text: caption || `📎 ${fileName}`,
      messageType: "document",
      mediaMimeType: m.documentMessage.mimetype ?? "application/octet-stream",
      mediaData: buffer?.toString("base64"),
      wasAudio: false,
    };
  }

  if (m.audioMessage) {
    const buffer = await downloadMedia(msg, sock);
    let text = "🎤 Nota de voz";
    if (options?.transcribeAudio !== false && buffer) {
      try {
        const mimetype = m.audioMessage.mimetype || "audio/ogg; codecs=opus";
        text = await transcribeAudio(buffer, mimetype);
      } catch (err) {
        logger.error({ err }, "Error transcribiendo audio");
      }
    }
    return {
      text: text.trim() || "🎤 Nota de voz",
      messageType: "audio",
      mediaMimeType: m.audioMessage.mimetype ?? "audio/ogg",
      mediaData: buffer?.toString("base64"),
      wasAudio: true,
    };
  }

  return null;
}
