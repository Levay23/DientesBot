import * as PImage from "pureimage";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fontLoaded = false;

async function ensureFontLoaded() {
  if (fontLoaded) return;
  try {
    let fontPath = path.join(__dirname, "assets/font.ttf");
    if (!fs.existsSync(fontPath)) {
      fontPath = path.join(__dirname, "../assets/font.ttf");
    }
    const font = PImage.registerFont(fontPath, "StandardFont");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Font loading timeout")), 5000);
      (font as { load: (cb: () => void) => void }).load(() => {
        clearTimeout(timeout);
        fontLoaded = true;
        resolve();
      });
    });
  } catch (err) {
    logger.error({ err }, "Error cargando fuente para recibo de pago");
    fontLoaded = true;
  }
}

async function drawLogo(ctx: ReturnType<ReturnType<typeof PImage.make>["getContext"]>) {
  try {
    let logoPath = path.join(__dirname, "public/logo.jpg");
    if (!fs.existsSync(logoPath)) {
      logoPath = path.join(__dirname, "../../../artifacts/crm/public/logo.jpg");
    }
    if (fs.existsSync(logoPath)) {
      const stream = fs.createReadStream(logoPath);
      const logo = await PImage.decodeJPEGFromStream(stream);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(15, 15, 120, 120);
      ctx.drawImage(logo, 20, 20, 110, 110);
    }
  } catch (e) {
    logger.warn("No se pudo cargar el logo para el recibo de pago");
  }
}

function formatCop(amount: number) {
  return `$${Math.abs(amount).toLocaleString("es-CO")}`;
}

function formatDateLabel(dateStr: string) {
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

export type PaymentReceiptData = {
  clinicName: string;
  clinicAddress?: string | null;
  patientName: string;
  paymentDate: string;
  treatmentName?: string | null;
  concept?: string | null;
  amount: number;
  paymentMethod: string;
  paymentType: string;
  quotationId?: number | null;
  quotationTotal?: number | null;
  quotationPaid?: number | null;
  quotationBalance?: number | null;
  expectedTotal?: number | null;
  treatmentPaid?: number | null;
  treatmentBalance?: number | null;
};

export async function generatePaymentReceiptImage(data: PaymentReceiptData): Promise<Buffer> {
  await ensureFontLoaded();

  const width = 800;
  const height = 920;
  const img = PImage.make(width, height);
  const ctx = img.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, width, 150);
  await drawLogo(ctx);

  ctx.fillStyle = "#ffffff";
  ctx.font = "26pt StandardFont";
  ctx.fillText("RECIBO DE PAGO", 160, 70);
  ctx.font = "16pt StandardFont";
  ctx.fillStyle = "#94a3b8";
  ctx.fillText(data.clinicName.toUpperCase(), 160, 105);
  if (data.clinicAddress) {
    ctx.font = "11pt StandardFont";
    const addr =
      data.clinicAddress.length > 48 ? `${data.clinicAddress.slice(0, 45)}...` : data.clinicAddress;
    ctx.fillText(addr, 160, 132);
  }

  let y = 190;
  const labelX = 50;
  const valueX = 280;

  const drawRow = (label: string, value: string, bold = false) => {
    ctx.fillStyle = "#64748b";
    ctx.font = "13pt StandardFont";
    ctx.fillText(label, labelX, y);
    ctx.fillStyle = bold ? "#0f172a" : "#334155";
    ctx.font = bold ? "14pt StandardFont" : "13pt StandardFont";
    ctx.fillText(value, valueX, y);
    y += 34;
  };

  drawRow("PACIENTE:", data.patientName, true);
  drawRow("FECHA DE ABONO:", formatDateLabel(data.paymentDate), true);

  const detail = data.treatmentName || data.concept || "Abono registrado";
  drawRow("CONCEPTO:", detail.length > 42 ? `${detail.slice(0, 39)}...` : detail);

  drawRow("TIPO:", data.paymentType);
  drawRow("MÉTODO:", data.paymentMethod);

  if (data.quotationId != null) {
    drawRow("PRESUPUESTO:", `#${data.quotationId}`);
  }

  y += 8;
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(40, y - 10, 720, 2);
  y += 18;

  if (data.expectedTotal != null && data.expectedTotal > 0) {
    drawRow("TOTAL TRATAMIENTO:", formatCop(data.expectedTotal));
    if (data.treatmentPaid != null) drawRow("TOTAL ABONADO:", formatCop(data.treatmentPaid));
    if (data.treatmentBalance != null) {
      drawRow("SALDO PENDIENTE:", formatCop(data.treatmentBalance), true);
    }
  }

  if (data.quotationTotal != null) {
    drawRow("TOTAL PRESUPUESTO:", formatCop(data.quotationTotal));
    if (data.quotationPaid != null) drawRow("ABONADO A LA FECHA:", formatCop(data.quotationPaid));
    if (data.quotationBalance != null) {
      drawRow("SALDO PRESUPUESTO:", formatCop(data.quotationBalance), true);
    }
  }

  y += 10;
  ctx.fillStyle = "#84cc16";
  ctx.fillRect(40, y, 720, 72);
  ctx.fillStyle = "#ffffff";
  ctx.font = "22pt StandardFont";
  const amountLabel = data.paymentType.toLowerCase().includes("devoluc") ? "DEVOLUCIÓN" : "MONTO ABONADO";
  ctx.fillText(amountLabel, 60, y + 48);
  ctx.font = "24pt StandardFont";
  ctx.fillText(formatCop(data.amount), 480, y + 48);

  y += 110;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "12pt StandardFont";
  ctx.fillText("Comprobante generado automáticamente por el sistema de facturación.", 50, y);
  ctx.fillText("Gracias por confiar en nosotros.", 50, y + 28);
  ctx.fillText(data.clinicName, 50, height - 40);

  const chunks: Buffer[] = [];
  const passThrough = new (await import("stream")).PassThrough();

  return new Promise((resolve, reject) => {
    passThrough.on("data", (chunk: Buffer) => chunks.push(chunk));
    passThrough.on("end", () => resolve(Buffer.concat(chunks)));
    passThrough.on("error", reject);
    PImage.encodeJPEGToStream(img, passThrough).catch(reject);
  });
}
