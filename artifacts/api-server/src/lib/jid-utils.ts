import type { proto } from "@whiskeysockets/baileys";

/** JID de WhatsApp para enviar mensajes (remoteJid tal cual llegó). */
export function parseIncomingContact(msg: proto.IWebMessageInfo): {
  whatsappJid: string;
  phone: string;
} | null {
  const remoteJid = msg.key?.remoteJid ?? "";
  if (!remoteJid || remoteJid.includes("@g.us") || remoteJid === "status@broadcast") {
    return null;
  }

  const key = msg.key as { remoteJidAlt?: string } | undefined;
  const altJid = key?.remoteJidAlt;
  const phoneFromAlt = altJid ? jidToDisplayPhone(altJid) : null;
  const phoneFromMain = jidToDisplayPhone(remoteJid);

  const userPart = remoteJid.split("@")[0].split(":")[0];
  const phone = phoneFromAlt ?? phoneFromMain ?? `+${userPart.replace(/\D/g, "")}`;

  return { whatsappJid: remoteJid, phone };
}

/** Convierte un JID @s.whatsapp.net a teléfono legible (+57...). */
export function jidToDisplayPhone(jid: string): string | null {
  if (!jid || jid.includes("@g.us")) return null;
  if (!jid.endsWith("@s.whatsapp.net")) return null;

  const user = jid.split("@")[0].split(":")[0];
  const clean = user.replace(/\D/g, "");
  if (!clean) return null;

  if (clean.length === 12 && clean.startsWith("57")) return `+${clean}`;
  if (clean.length === 10 && clean.startsWith("3")) return `+57${clean}`;
  if (clean.length >= 10 && clean.length <= 13) return `+${clean}`;

  return null;
}

/** JID para envío a partir de teléfono solo si parece número real (no ID @lid). */
export function phoneToJidIfValid(phone: string): string | null {
  const clean = phone.replace(/\D/g, "");
  if (!clean) return null;

  if (clean.length === 12 && clean.startsWith("57")) return `${clean}@s.whatsapp.net`;
  if (clean.length === 10 && clean.startsWith("3")) return `57${clean}@s.whatsapp.net`;
  if (clean.length === 11 && clean.startsWith("57")) return `${clean}@s.whatsapp.net`;

  // IDs internos de WhatsApp (14+ dígitos sin formato CO) — no usar
  if (clean.length > 13) return null;

  return null;
}

export function resolveOutboundJid(
  conv: { whatsappJid?: string | null; phone: string },
  patientPhone?: string | null,
): string | null {
  if (conv.whatsappJid?.includes("@")) return conv.whatsappJid;
  if (patientPhone) {
    const fromPatient = phoneToJidIfValid(patientPhone);
    if (fromPatient) return fromPatient;
  }
  return phoneToJidIfValid(conv.phone);
}
