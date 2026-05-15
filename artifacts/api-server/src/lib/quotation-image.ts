import * as PImage from "pureimage";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fontLoaded = false;
async function ensureFontLoaded() {
  if (fontLoaded) return;
  try {
    const font = PImage.registerFont(path.join(__dirname, "assets/font.ttf"), "StandardFont");
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

  // Draw Logo if exists - in production it will be in dist/public/
  try {
    const logoPath = path.join(__dirname, "public/logo.jpg");
    if (fs.existsSync(logoPath)) {
       const stream = fs.createReadStream(logoPath);
       const logo = await PImage.decodeJPEGFromStream(stream);
       // Center logo in header
       ctx.drawImage(logo, 20, 20, 110, 110);
    }
  } catch (e) {
    // Ignore logo errors
  }

  // Header Text
  ctx.fillStyle = "#ffffff";
  ctx.font = "32pt StandardFont"; 
  
  ctx.fillText("PRESUPUESTO ODONTOLÓGICO", 160, 80);
  ctx.font = "20pt StandardFont";
  ctx.fillText(data.clinicName, 160, 120);

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
  const stream = new (await import("stream")).PassThrough();
  await PImage.encodeJPEGToStream(img, stream);
  
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
