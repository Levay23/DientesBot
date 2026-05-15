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
      (font as any).load(() => {
        clearTimeout(timeout);
        fontLoaded = true;
        resolve();
      });
    });
  } catch (err) {
    console.error("Error loading font for quotations:", err);
    // Continue anyway, maybe it works with system font fallback
    fontLoaded = true; 
  }
}

export async function generateQuotationImage(data: {


  clinicName: string;
  patientName: string;
  items: { service: string; price: number; quantity: number }[];
  total: number;
}): Promise<Buffer> {
  await ensureFontLoaded();
  const width = 800;

  const height = 1000;
  const img = PImage.make(width, height);
  const ctx = img.getContext("2d");

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // Decorative header (Navy Blue)
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, width, 150);

  // Draw Logo if exists
  try {
    let logoPath = path.join(__dirname, "public/logo.jpg");
    if (!fs.existsSync(logoPath)) {
      // Intentar ruta de desarrollo si no está en dist
      logoPath = path.join(__dirname, "../../../artifacts/crm/public/logo.jpg");
    }

    if (fs.existsSync(logoPath)) {
       const stream = fs.createReadStream(logoPath);
       const logo = await PImage.decodeJPEGFromStream(stream);
       // Dibujar logo con un borde blanco circular simulado o simplemente ajustado
       ctx.fillStyle = "#ffffff";
       ctx.fillRect(15, 15, 120, 120);
       ctx.drawImage(logo, 20, 20, 110, 110);
    }
  } catch (e) {
    logger.warn("No se pudo cargar el logo para el presupuesto");
  }

  // Header Text
  ctx.fillStyle = "#ffffff";
  ctx.font = "28pt StandardFont"; 
  ctx.fillText("PRESUPUESTO", 160, 75);
  ctx.font = "18pt StandardFont";
  ctx.fillText("ODONTOLÓGICO", 160, 105);
  
  ctx.font = "14pt StandardFont";
  ctx.fillStyle = "#94a3b8"; // Slate 400
  ctx.fillText(data.clinicName.toUpperCase(), 160, 135);

  // Patient Info
  ctx.fillStyle = "#334155";
  ctx.font = "16pt StandardFont";
  ctx.fillText(`PACIENTE: ${data.patientName}`, 50, 200);
  ctx.fillText(`FECHA: ${new Date().toLocaleDateString()}`, 50, 230);

  // Table Header
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(50, 280, 700, 40);
  ctx.fillStyle = "#0f172a";
  ctx.font = "12pt StandardFont";
  ctx.fillText("SERVICIO / TRATAMIENTO", 60, 305);
  ctx.fillText("CANT", 430, 305);
  ctx.fillText("P. UNIT", 520, 305);
  ctx.fillText("SUBTOTAL", 640, 305);

  // Table Items
  let y = 350;
  data.items.forEach((item, idx) => {
    ctx.fillStyle = idx % 2 === 0 ? "#ffffff" : "#f1f5f9";
    ctx.fillRect(50, y - 25, 700, 40);
    ctx.fillStyle = "#334155";
    ctx.font = "13pt StandardFont";
    
    // Service name (truncate if too long)
    const serviceName = item.service.length > 30 ? item.service.substring(0, 27) + "..." : item.service;
    ctx.fillText(serviceName, 60, y);
    
    ctx.fillText(String(item.quantity || 1), 440, y);
    ctx.fillText(`$${item.price.toLocaleString()}`, 520, y);
    
    const subtotal = (item.price * (item.quantity || 1));
    ctx.fillText(`$${subtotal.toLocaleString()}`, 640, y);
    
    y += 45;
  });

  // Total
  ctx.fillStyle = "#84cc16"; // Lime Green
  ctx.fillRect(50, y + 20, 700, 60);
  ctx.fillStyle = "#ffffff";
  ctx.font = "20pt StandardFont";
  ctx.fillText("TOTAL ESTIMADO", 70, y + 60);
  ctx.fillText(`$${data.total.toLocaleString()}`, 610, y + 60);

  // Footer
  ctx.fillStyle = "#94a3b8";
  ctx.font = "12pt StandardFont";
  ctx.fillText("Este presupuesto tiene una validez de 30 días.", 50, height - 100);
  ctx.fillText("Gracias por confiar en nosotros.", 50, height - 70);


  // Export to Buffer
  const chunks: any[] = [];
  const passThrough = new (await import("stream")).PassThrough();
  
  return new Promise((resolve, reject) => {
    passThrough.on("data", (chunk: Buffer) => chunks.push(chunk));
    passThrough.on("end", () => {
      const finalBuffer = Buffer.concat(chunks);
      logger.info({ size: finalBuffer.length }, "Imagen de presupuesto generada exitosamente");
      resolve(finalBuffer);
    });
    passThrough.on("error", (err: Error) => {
      logger.error({ err }, "Error en passThrough de pureimage");
      reject(err);
    });

    // En pureimage, esta función escribe al stream proporcionado
    PImage.encodeJPEGToStream(img, passThrough).catch(reject);
  });
}
