import { Pool, types } from 'pg';
import { env } from '../config/env';
import { messages } from '../constants/messages';
import { logger } from '../utils/logger';

// DATE 列直接返回 YYYY-MM-DD 字符串，避免 node-postgres 按 UTC 午夜解析后在不同时区发生日期漂移
types.setTypeParser(1082, (value: string) => value);

const pool = new Pool({
  host: env.database.host,
  port: env.database.port,
  database: env.database.name,
  user: env.database.user,
  password: env.database.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error(messages.errors.idleClient, err);
});

export default pool;
