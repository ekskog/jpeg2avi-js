import express from 'express';
import multer from 'multer';
import winston from 'winston';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import redisService from './src/services/redis-service.js';
import jobService from './src/services/job-service.js';
import ConversionWorker from './src/services/conversion-worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CI/CD trigger - force rebuild for public image - with latest tag - v1.1
// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Configure Winston logger - SIMPLE VERSION
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'conversion.log') }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const app = express();
const port = process.env.PORT || 3000;

// Initialize Redis connection
async function initializeRedis() {
  try {
    await redisService.connect();
    logger.info('Redis connected successfully');
  } catch (error) {
    logger.error('Failed to connect to Redis:', error.message);
    process.exit(1);
  }
}

// Initialize conversion worker
const conversionWorker = new ConversionWorker();

// Start background worker
async function startWorker() {
  try {
    // Start the conversion worker in background
    conversionWorker.start().catch(error => {
      logger.error('Worker crashed:', error.message);
      // Restart worker after 5 seconds
      setTimeout(startWorker, 5000);
    });
    logger.info('Conversion worker started');
  } catch (error) {
    logger.error('Failed to start worker:', error.message);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for memory storage (more efficient for streams)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Check if file is a JPEG
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG files are allowed'), false);
    }
  }
});

// Utility function to get memory usage
function getMemoryUsage() {
  const used = process.memoryUsage();
  return {
    rss: Math.round(used.rss / 1024 / 1024 * 100) / 100, // MB
    heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100, // MB
    heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100, // MB
    external: Math.round(used.external / 1024 / 1024 * 100) / 100 // MB
  };
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    memory: getMemoryUsage(),
    redis: redisService.isConnected() ? 'connected' : 'disconnected'
  });
});

// Non-blocking conversion endpoint - Returns job ID immediately
app.post('/convert', upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  logger.info('Conversion request received', {
    requestId,
    filename: req.file?.originalname,
    fileSize: req.file?.size
  });

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Check Redis connection
    if (!redisService.isConnected()) {
      return res.status(503).json({ 
        error: 'Service temporarily unavailable - job queue not ready' 
      });
    }

    // Create job with image data
    const job = await jobService.createJob({
      originalName: req.file.originalname,
      imageData: req.file.buffer.toString('base64'),
      fileSize: req.file.size,
      requestId
    });

    const processingTime = Date.now() - startTime;

    logger.info('Job created successfully', {
      requestId,
      jobId: job.id,
      processingTime
    });

    // Return job ID immediately - conversion happens in background
    res.json({
      success: true,
      jobId: job.id,
      status: 'queued',
      message: 'Image queued for conversion',
      processingTime,
      statusUrl: `/status/${job.id}`
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;

    logger.error('Failed to create conversion job', {
      requestId,
      error: error.message,
      processingTime
    });

    res.status(500).json({
      success: false,
      error: error.message,
      processingTime
    });
  }
});

// Job status endpoint - Check conversion progress and get results
app.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  
  try {
    // Check Redis connection
    if (!redisService.isConnected()) {
      return res.status(503).json({ 
        error: 'Service temporarily unavailable - job queue not ready' 
      });
    }

    const job = await jobService.getJobStatus(jobId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    // Return job status and results if completed
    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      processingTime: job.processingTime,
      results: job.results,
      error: job.error
    });

  } catch (error) {
    logger.error('Failed to get job status', {
      jobId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Legacy synchronous endpoint for backward compatibility (deprecated)
app.post('/convert-sync', upload.single('image'), async (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Synchronous conversion endpoint deprecated. Use POST /convert and GET /status/:jobId instead.',
    migration: {
      step1: 'POST /convert - returns jobId immediately',
      step2: 'GET /status/:jobId - check status and get results'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
    }
  }
  
  logger.error('Unhandled error', {
    error: error.message,
    stack: error.stack
  });
  
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize imagemin for AVIF conversion
logger.info('AVIF converter initialized');
logger.info('AVIF support: YES (via imagemin-avif)');

// Start server with Redis initialization
async function startServer() {
  try {
    // Initialize Redis connection
    await initializeRedis();
    
    // Start conversion worker
    await startWorker();
    
    // Start HTTP server
    app.listen(port, () => {
      logger.info(`Non-blocking JPEG to AVIF conversion service started on port ${port}`, {
        port,
        nodeVersion: process.version,
        initialMemory: getMemoryUsage(),
        redis: redisService.isConnected() ? 'connected' : 'disconnected'
      });
    });
    
  } catch (error) {
    logger.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

// Start the server
startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  
  // Stop conversion worker
  await conversionWorker.stop();
  
  // Disconnect from Redis
  await redisService.disconnect();
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  
  // Stop conversion worker
  await conversionWorker.stop();
  
  // Disconnect from Redis
  await redisService.disconnect();
  
  process.exit(0);
});