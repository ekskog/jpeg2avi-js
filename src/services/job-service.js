import { v4 as uuidv4 } from 'uuid';
import redisService from './redis-service.js';
import winston from 'winston';

class JobService {
  constructor() {
    this.keyPrefix = 'jpeg2avif:job:';
    this.queueKey = 'jpeg2avif:queue';
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

  async createJob(jobData) {
    const jobId = uuidv4();
    const job = {
      id: jobId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...jobData
    };

    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot create job');
    }

    try {
      // Store job data
      await redisService.set(
        `${this.keyPrefix}${jobId}`,
        job,
        86400 // 24 hours expiry
      );
      
      // Add to processing queue
      await redisService.lpush(this.queueKey, { jobId });
      
      this.logger.info(`Created job ${jobId} with status: ${job.status}`);
      return job;
    } catch (error) {
      this.logger.error(`Failed to create job:`, error.message);
      throw new Error(`Failed to create job: ${error.message}`);
    }
  }

  async getJobStatus(jobId) {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot get job status');
    }

    try {
      const job = await redisService.get(`${this.keyPrefix}${jobId}`);
      if (!job) {
        return null;
      }

      return job;
    } catch (error) {
      this.logger.error(`Failed to get job status for ${jobId}:`, error.message);
      throw new Error(`Failed to get job status: ${error.message}`);
    }
  }

  async updateJobStatus(jobId, updates) {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot update job status');
    }

    try {
      const job = await this.getJobStatus(jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      const updatedJob = {
        ...job,
        ...updates,
        updatedAt: new Date().toISOString()
      };

      await redisService.set(
        `${this.keyPrefix}${jobId}`,
        updatedJob,
        86400 // 24 hours expiry
      );

      this.logger.info(`Updated job ${jobId} status to: ${updatedJob.status}`);
      return updatedJob;
    } catch (error) {
      this.logger.error(`Failed to update job status for ${jobId}:`, error.message);
      throw new Error(`Failed to update job status: ${error.message}`);
    }
  }

  async getNextJob() {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot get next job');
    }

    try {
      // Block and wait for next job (30 second timeout)
      const result = await redisService.brpop(this.queueKey, 30);
      if (!result) {
        return null;
      }

      const { jobId } = result;
      const job = await this.getJobStatus(jobId);
      
      if (!job) {
        this.logger.warn(`Job ${jobId} not found in Redis, skipping`);
        return null;
      }

      return job;
    } catch (error) {
      this.logger.error(`Failed to get next job:`, error.message);
      throw new Error(`Failed to get next job: ${error.message}`);
    }
  }

  async deleteJob(jobId) {
    if (!redisService.isConnected()) {
      throw new Error('Redis not connected - cannot delete job');
    }

    try {
      await redisService.del(`${this.keyPrefix}${jobId}`);
      this.logger.info(`Deleted job ${jobId}`);
    } catch (error) {
      this.logger.error(`Failed to delete job ${jobId}:`, error.message);
      throw new Error(`Failed to delete job: ${error.message}`);
    }
  }
}

export default new JobService();
