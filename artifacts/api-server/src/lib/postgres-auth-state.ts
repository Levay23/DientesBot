import { initAuthCreds, BufferJSON, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { db, whatsappAuthTable } from "@workspace/db";
import { eq, like, sql } from "drizzle-orm";
import { logger } from "./logger";

function scopedKey(userId: number, key: string): string {
  return `${userId}::${key}`;
}

export async function usePostgresAuthState(userId: number): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearAuth: () => Promise<void>;
}> {
  async function writeKey(key: string, data: unknown): Promise<void> {
    const value = JSON.stringify(data, BufferJSON.replacer);
    const fullKey = scopedKey(userId, key);
    await db
      .insert(whatsappAuthTable)
      .values({ key: fullKey, value })
      .onConflictDoUpdate({ target: whatsappAuthTable.key, set: { value } });
  }

  async function readKey<T>(key: string): Promise<T | null> {
    try {
      const fullKey = scopedKey(userId, key);
      const [row] = await db.select().from(whatsappAuthTable).where(eq(whatsappAuthTable.key, fullKey));
      if (!row) return null;
      return JSON.parse(row.value, BufferJSON.reviver) as T;
    } catch {
      return null;
    }
  }

  async function deleteKey(key: string): Promise<void> {
    await db.delete(whatsappAuthTable).where(eq(whatsappAuthTable.key, scopedKey(userId, key)));
  }

  let creds = await readKey<any>("creds");
  if (!creds || !creds.me) {
    creds = initAuthCreds();
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const value = await readKey<SignalDataTypeMap[T]>(`${type}:${id}`);
            if (value) result[id] = value;
          }),
        );
        return result;
      },

      set: async (data: SignalDataSet): Promise<void> => {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const categoryData = data[category];
          if (!categoryData) continue;
          for (const id of Object.keys(categoryData)) {
            const value = categoryData[id];
            const key = `${String(category)}:${id}`;
            if (value != null) {
              tasks.push(writeKey(key, value));
            } else {
              tasks.push(deleteKey(key));
            }
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  const saveCreds = async (): Promise<void> => {
    await writeKey("creds", state.creds);
  };

  const clearAuth = async (): Promise<void> => {
    logger.info({ userId }, "Clearing WhatsApp auth from DB");
    await db.delete(whatsappAuthTable).where(like(whatsappAuthTable.key, `${userId}::%`));
  };

  return { state, saveCreds, clearAuth };
}
