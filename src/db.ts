// src/db.ts
import { Surreal } from 'surrealdb'

export const db = new Surreal()

export async function connectDB() {
  const url = process.env.SURREAL_URL ?? 'ws://localhost:8000/rpc'
  await db.connect(url)
  await db.signin({ username: 'root', password: 'root' })
  await db.use({ namespace: 'maimai', database: 'maimai' })
  console.log('✅ SurrealDB 連線成功')
}
