import { Pool, type PoolClient, type QueryResultRow } from 'pg'

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/maimai'

export const db = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? 10),
})

export async function connectDB() {
  const client = await db.connect()
  try {
    await client.query('SELECT 1')
    console.log('PostgreSQL connected')
  } finally {
    client.release()
  }
}

export async function query<T extends QueryResultRow = any>(text: string, params: unknown[] = []) {
  const result = await db.query<T>(text, params)
  return result.rows
}

export async function one<T extends QueryResultRow = any>(text: string, params: unknown[] = []) {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
