import { generateQuotationImage } from "../artifacts/api-server/src/lib/quotation-image";
import * as fs from "fs";
import * as path from "path";

async function test() {
  console.log("Iniciando prueba de generación de imagen...");
  try {
    const buffer = await generateQuotationImage({
      clinicName: "Clínica Dental de Prueba",
      patientName: "Juan Pérez",
      items: [
        { service: "Limpieza Dental", price: 150000, quantity: 1 },
        { service: "Resina Estética", price: 120000, quantity: 2 },
        { service: "Blanqueamiento", price: 450000, quantity: 1 }
      ],
      total: 840000
    });

    const outputPath = path.join(process.cwd(), "scratch/test-quotation.jpg");
    fs.writeFileSync(outputPath, buffer);
    console.log(`Imagen generada exitosamente en: ${outputPath}`);
    console.log(`Tamaño del archivo: ${buffer.length} bytes`);
  } catch (err) {
    console.error("Error en la prueba:", err);
  }
}

test().catch(console.error);
