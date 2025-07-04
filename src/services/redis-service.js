import { createClient } from 'redis';
import winston from 'winston';

class RedisService {
  constructor() {
    this.client = null;
    this.connected = false;
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.timestamp({ format: 'HH:mm:ss' }),
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });
  }

  async connect() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = process.env.REDIS_PORT || 6379;
    const redisDb = process.env.REDIS_DB || 0;
    const redisPassword = process.env.REDIS_PASSWORD || '';

    try {
      this.client = createClient({
        socket: {
          host: redisHost,
          port: redisPort,
          connectTimeout: 10000,
          lazyConnect: true
        },
        database: redisDb,
        password: redisPassword || undefined
      });

      this.client.on('error', (err) => {
        this.logger.error('Redis Client Error:', err.message);
        this.connected = false;
      });

      this.client.on('connect', () => {
        this.logger.info('Redis client connected');
        this.connected = true;
      });

      this.client.on('ready', () => {
        this.logger.info('Redis client ready');
        this.connected = true;
      });

      this.client.on('end', () => {
        this.logger.info('Redis client disconnected');
        this.connected = false;
      });

      await this.client.connect();
      this.logger.info(`Connected to Redis at ${redisHost}:${redisPort}, DB: ${redisDb}`);
      
      return true;
    } catch (error) {
      this.logger.error('Failed to connect to Redis:', error.message);
      this.connected = false;
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.connected = false;
      this.logger.info('Redis client disconnected');
    }
  }

  isConnected() {
    return this.connected;
  }

  getClient() {
    if (!this.isConnected()) {
      throw new Error('Redis client not connected');
    }
    return this.client;
  }

  async set(key, value, ttl = null) {
    const client = this.getClient();
    if (ttl) {
      return await client.setEx(key, ttl, JSON.stringify(value));
    } else {
      return await client.set(key, JSON.stringify(value));
    }
  }

  async get(key) {
    const client = this.getClient();
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  }

  async del(key) {
    const client = this.getClient();
    return await client.del(key);
  }

  async lpush(key, value) {
    const client = this.getClient();
    return await client.lPush(key, JSON.stringify(value));
  }

  async brpop(key, timeout = 0) {
    const client = this.getClient();
    const result = await client.brPop(key, timeout);
    return result ? JSON.parse(result.element) : null;
  }
}

export default new RedisService();
