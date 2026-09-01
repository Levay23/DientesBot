import XLSX from "xlsx";
import fs from "fs";
import path from "path";

const API_BASE = "https://dientesbot-api.onrender.com/api";

async function main() {
  console.log("Conectando al servidor API para extraer base de datos...");
  
  // 1. Iniciar sesión para obtener token
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "admin@dientesfijosmedellin.com",
      password: "Dientes123"
    })
  });
  
  if (!loginRes.ok) {
    throw new Error(`Error en login: ${loginRes.statusText}`);
  }
  
  const { token } = await loginRes.json();
  const headers = { Authorization: `Bearer ${token}` };
  
  console.log("Autenticación exitosa. Extrayendo tablas...");
  
  // 2. Extraer datos en paralelo
  const [
    patientsRes,
    appointmentsRes,
    conversationsRes,
    treatmentsRes,
    quotationsRes,
    paymentsRes,
    knowledgeRes,
    automationsRes
  ] = await Promise.all([
    fetch(`${API_BASE}/patients`, { headers }),
    fetch(`${API_BASE}/appointments`, { headers }),
    fetch(`${API_BASE}/conversations`, { headers }),
    fetch(`${API_BASE}/treatments`, { headers }),
    fetch(`${API_BASE}/quotations`, { headers }),
    fetch(`${API_BASE}/billing/payments`, { headers }),
    fetch(`${API_BASE}/ai-knowledge`, { headers }),
    fetch(`${API_BASE}/automations`, { headers })
  ]);

  const patients = patientsRes.ok ? await patientsRes.json() : [];
  const appointments = appointmentsRes.ok ? await appointmentsRes.json() : [];
  const conversations = conversationsRes.ok ? await conversationsRes.json() : [];
  const treatments = treatmentsRes.ok ? await treatmentsRes.json() : [];
  const quotations = quotationsRes.ok ? await quotationsRes.json() : [];
  const payments = paymentsRes.ok ? await paymentsRes.json() : [];
  const knowledge = knowledgeRes.ok ? await knowledgeRes.json() : [];
  const automations = automationsRes.ok ? await automationsRes.json() : [];

  console.log(`- Pacientes: ${patients.length}`);
  console.log(`- Citas: ${appointments.length}`);
  console.log(`- Conversaciones WhatsApp: ${conversations.length}`);
  console.log(`- Tratamientos en catálogo: ${treatments.length}`);
  console.log(`- Cotizaciones: ${quotations.length}`);
  console.log(`- Pagos/Abonos: ${payments.length}`);
  console.log(`- Artículos de Conocimiento IA: ${knowledge.length}`);
  console.log(`- Automatizaciones: ${automations.length}`);

  // 3. Formatear y limpiar datos para Excel
  const wb = XLSX.utils.book_new();

  // Tab 1: Pacientes
  const formattedPatients = patients.map((p) => ({
    "ID": p.id,
    "Nombre": p.name || "",
    "Cédula": p.cedula || "",
    "Teléfono": p.phone || "",
    "Email": p.email || "",
    "Edad": p.age || "",
    "Tratamiento Interés": p.treatment || "",
    "Estado": p.status || "",
    "Última Visita": p.lastVisit ? new Date(p.lastVisit).toLocaleDateString("es-CO") : "",
    "Ciudad": p.city || "",
    "Barrio": p.neighborhood || "",
    "Referido Por": p.referralSource || "",
    "Notas Médicas": p.medicalHistory || "",
    "Notas Generales": p.notes || "",
    "Fecha Registro": p.createdAt ? new Date(p.createdAt).toLocaleString("es-CO") : ""
  }));
  const wsPatients = XLSX.utils.json_to_sheet(formattedPatients);
  XLSX.utils.book_append_sheet(wb, wsPatients, "Pacientes");

  // Tab 2: Citas
  const formattedAppointments = appointments.map((a) => ({
    "ID Cita": a.id,
    "ID Paciente": a.patientId,
    "Nombre Paciente": a.patient?.name || a.patientName || "",
    "Teléfono Paciente": a.patient?.phone || a.patientPhone || "",
    "Fecha Cita": a.date || "",
    "Hora Inicio": a.startTime || "",
    "Hora Fin": a.endTime || "",
    "Tratamiento": a.treatment || "",
    "Estado": a.status || "",
    "Notas": a.notes || "",
    "Fecha Creación": a.createdAt ? new Date(a.createdAt).toLocaleString("es-CO") : ""
  }));
  const wsAppointments = XLSX.utils.json_to_sheet(formattedAppointments);
  XLSX.utils.book_append_sheet(wb, wsAppointments, "Citas");

  // Tab 3: Conversaciones WhatsApp
  const formattedConversations = conversations.map((c) => ({
    "ID Conversación": c.id,
    "Nombre Paciente": c.patientName || "",
    "Teléfono": c.phone || "",
    "WhatsApp JID": c.whatsappJid || "",
    "Estado Chat": c.status || "",
    "Modo IA Activo": c.aiMode ? "Sí" : "No",
    "Mensajes No Leídos": c.unreadCount || 0,
    "Último Mensaje": c.lastMessage || "",
    "Fecha Último Mensaje": c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString("es-CO") : ""
  }));
  const wsConversations = XLSX.utils.json_to_sheet(formattedConversations);
  XLSX.utils.book_append_sheet(wb, wsConversations, "Conversaciones_WhatsApp");

  // Tab 4: Tratamientos
  const formattedTreatments = treatments.map((t) => ({
    "ID": t.id,
    "Tratamiento": t.name,
    "Precio Base (COP)": t.price,
    "Categoría": t.category || "",
    "Duración Estimada (min)": t.durationMinutes || 60,
    "Activo": t.active ? "Sí" : "No",
    "Descripción": t.description || ""
  }));
  const wsTreatments = XLSX.utils.json_to_sheet(formattedTreatments);
  XLSX.utils.book_append_sheet(wb, wsTreatments, "Tratamientos");

  // Tab 5: Cotizaciones
  const formattedQuotations = quotations.map((q) => ({
    "ID Cotización": q.id,
    "ID Paciente": q.patientId,
    "Nombre Paciente": q.patient?.name || "",
    "Total (COP)": q.total,
    "Estado": q.status || "",
    "Servicios": Array.isArray(q.items) ? q.items.map(i => `${i.service} ($${i.price})`).join("; ") : "",
    "Observaciones": q.observations || "",
    "Fecha": q.createdAt ? new Date(q.createdAt).toLocaleString("es-CO") : ""
  }));
  const wsQuotations = XLSX.utils.json_to_sheet(formattedQuotations);
  XLSX.utils.book_append_sheet(wb, wsQuotations, "Cotizaciones");

  // Tab 6: Pagos y Abonos
  const formattedPayments = payments.map((p) => ({
    "ID Pago": p.id,
    "ID Paciente": p.patientId,
    "Nombre Paciente": p.patient?.name || "",
    "Monto (COP)": p.amount,
    "Método de Pago": p.paymentMethod || "",
    "Tipo de Pago": p.paymentType || "",
    "Concepto / Tratamiento": p.concept || p.treatmentName || "",
    "Fecha Pago": p.paymentDate || "",
    "Notas": p.notes || ""
  }));
  const wsPayments = XLSX.utils.json_to_sheet(formattedPayments);
  XLSX.utils.book_append_sheet(wb, wsPayments, "Pagos_Abonos");

  // Tab 7: Base de Conocimiento IA
  const formattedKnowledge = knowledge.map((k) => ({
    "ID": k.id,
    "Título": k.title,
    "Categoría": k.category,
    "Activo": k.active ? "Sí" : "No",
    "Contenido": k.content
  }));
  const wsKnowledge = XLSX.utils.json_to_sheet(formattedKnowledge);
  XLSX.utils.book_append_sheet(wb, wsKnowledge, "Conocimiento_IA");

  // Guardar archivo Excel
  const nowStr = new Date().toISOString().split("T")[0];
  const outputFileName = `Base_de_Datos_DientesFijos_${nowStr}.xlsx`;
  const outputPath = path.resolve(process.cwd(), outputFileName);

  XLSX.writeFile(wb, outputPath);
  console.log(`\n✅ Archivo Excel generado exitosamente: ${outputPath}`);
}

main().catch((err) => {
  console.error("Error al exportar base de datos:", err);
  process.exit(1);
});
