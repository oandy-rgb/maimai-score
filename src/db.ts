// src/db.ts
import { Surreal } from 'surrealdb'

export const db = new Surreal()

const SURREAL_URL = process.env.SURREAL_URL ?? 'ws://localhost:8000/rpc'

async function connect() {
  await db.connect(SURREAL_URL)
  await db.signin({ username: 'root', password: 'root' })
  await db.use({ namespace: 'maimai', database: 'maimai' })
  console.log('✅ SurrealDB 連線成功')
}

export async function connectDB() {
  await connect()

  // 每 30 秒心跳檢測，斷線自動重連
  setInterval(async () => {
    try {
      await db.query('SELECT 1')
    } catch {
      console.log('⚠️ SurrealDB 連線斷開，嘗試重連...')
      try {
        await db.close()
      } catch {}
      try {
        await connect()
        console.log('✅ SurrealDB 重連成功')
      } catch (e) {
        console.error('❌ SurrealDB 重連失敗:', e)
      }
    }
  }, 30_000)
}
