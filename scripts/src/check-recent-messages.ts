import pg from "pg";

const url = process.env.RENDER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL");
  process.exit(1);
}

const ssl = { rejectUnauthorized: false };

async function main() {
  const c = new pg.Client({ connectionString: url, ssl });
  await c.connect();

  const phone = process.argv[2] ?? "573238385475";

  const convs = await c.query(
    `SELECT id, patient_name, phone, last_message, last_message_at, whatsapp_jid
     FROM conversations
     WHERE phone LIKE $1 OR phone LIKE $2
     ORDER BY last_message_at DESC NULLS LAST`,
    [`%${phone}%`, `%+${phone}%`],
  );
  console.log("\nConversaciones:", convs.rows);

  for (const conv of convs.rows) {
    const msgs = await c.query(
      `SELECT id, sender, LEFT(content, 80) AS content, sent_at, whatsapp_msg_id
       FROM messages WHERE conversation_id = $1
       ORDER BY sent_at DESC LIMIT 8`,
      [conv.id],
    );
    console.log(`\nÚltimos mensajes conv #${conv.id}:`);
    for (const m of msgs.rows) console.log(`  ${m.sent_at} [${m.sender}] ${m.content}`);
  }

  const latest = await c.query(
    `SELECT m.id, m.sender, LEFT(m.content, 60) AS content, m.sent_at, c.phone, c.patient_name
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     ORDER BY m.sent_at DESC LIMIT 10`,
  );
  console.log("\nÚltimos 10 mensajes globales:");
  for (const m of latest.rows) {
    console.log(`  ${m.sent_at} ${m.patient_name} (${m.phone}) [${m.sender}] ${m.content}`);
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
