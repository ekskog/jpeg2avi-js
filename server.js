const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const winston = require('winston');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// CI/CD trigger - force rebuild for public image - with latest tag
// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Configure Winston logger
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
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          // Format different types of log messages
          if (meta.requestId) {
            if (message.includes('started')) {
              return `${timestamp} ${level}: Request ${meta.requestId} - ${meta.filename} (${(meta.fileSize / 1024 / 1024).toFixed(2)}MB)`;
            } else if (message.includes('metadata extracted')) {
              return `${timestamp} ${level}: ${meta.requestId} - ${meta.width}×${meta.height} ${meta.format.toUpperCase()} (${meta.channels} channels)`;
            } else if (message.includes('completed successfully')) {
              const thumbnailComp = Math.round((1 - meta.thumbnailSize / meta.originalSize) * 100);
              const fullSizeComp = Math.round((1 - meta.fullSizeSize / meta.originalSize) * 100);
              return `${timestamp} ${level}: ${meta.requestId} - Completed in ${meta.processingTime}ms\n` +
                     `    Compression: Thumbnail ${thumbnailComp}%, Full-size ${fullSizeComp}%\n` +
                     `    Memory: ${meta.memoryBefore.heapUsed}MB → ${meta.memoryAfter.heapUsed}MB (Δ${meta.memoryDelta.heapUsed > 0 ? '+' : ''}${meta.memoryDelta.heapUsed.toFixed(2)}MB)`;
            } else if (message.includes('failed')) {
              return `${timestamp} ${level}: ${meta.requestId} - ${meta.error} (${meta.processingTime}ms)`;
            }
          } else if (message.includes('service started')) {
            return `${timestamp} ${level}: JPEG to AVIF service started on port ${meta.port}\n` +
                   `    Node.js ${meta.nodeVersion} | Sharp ${meta.sharpVersion}\n` +
                   `    Initial memory: ${meta.initialMemory.heapUsed}MB heap, ${meta.initialMemory.rss}MB RSS`;
          } else if (message.includes('SIGTERM') || message.includes('SIGINT')) {
            return `${timestamp} ${level}: ${message}`;
          }
          
          // Fallback for other messages
          return `${timestamp} ${level}: ${message}`;
        })
      )
    })
  ]
});

const app = express();
const port = process.env.PORT || 3000;

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
    memory: getMemoryUsage()
  });
});

// Main conversion endpoint - Always returns both thumbnail and full-size variants
app.post('/convert', upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  let memoryBefore = getMemoryUsage();
  
  logger.info('Conversion request started', {
    requestId,
    filename: req.file?.originalname,
    fileSize: req.file?.size,
    memoryBefore
  });

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const inputBuffer = req.file.buffer;
    
    // Get image metadata
    const metadata = await sharp(inputBuffer).metadata();
    
    logger.info('Image metadata extracted', {
      requestId,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      channels: metadata.channels
    });

    // Process both images concurrently for maximum efficiency
    const [thumbnailBuffer, fullSizeBuffer] = await Promise.all([
      // Create thumbnail (200x200)
      sharp(inputBuffer)
        .resize(200, 200, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .avif({
          quality: 80,
          effort: 6
        })
        .toBuffer(),
      
      // Create full-size AVIF
      sharp(inputBuffer)
        .avif({
          quality: 85,
          effort: 6
        })
        .toBuffer()
    ]);

    const memoryAfter = getMemoryUsage();
    const processingTime = Date.now() - startTime;

    // Log conversion results
    logger.info('Conversion completed successfully', {
      requestId,
      processingTime,
      memoryBefore,
      memoryAfter,
      memoryDelta: {
        rss: memoryAfter.rss - memoryBefore.rss,
        heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed
      },
      originalSize: inputBuffer.length,
      thumbnailSize: thumbnailBuffer.length,
      fullSizeSize: fullSizeBuffer.length,
      compressionRatio: {
        thumbnail: Math.round((1 - thumbnailBuffer.length / inputBuffer.length) * 100),
        fullSize: Math.round((1 - fullSizeBuffer.length / inputBuffer.length) * 100)
      }
    });

    // Clear input buffer from memory
    inputBuffer.fill(0);

    // Return both images as base64 encoded strings
    res.json({
      success: true,
      requestId,
      processingTime,
      thumbnail: {
        data: thumbnailBuffer.toString('base64'),
        size: thumbnailBuffer.length,
        format: 'avif'
      },
      fullSize: {
        data: fullSizeBuffer.toString('base64'),
        size: fullSizeBuffer.length,
        format: 'avif'
      },
      originalSize: inputBuffer.length,
      memoryUsage: {
        before: memoryBefore,
        after: memoryAfter
      }
    });

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

  } catch (error) {
    const memoryAfter = getMemoryUsage();
    const processingTime = Date.now() - startTime;

    logger.error('Conversion failed', {
      requestId,
      error: error.message,
      stack: error.stack,
      processingTime,
      memoryBefore,
      memoryAfter
    });

    res.status(500).json({
      success: false,
      requestId,
      error: error.message,
      processingTime
    });
  }
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

// Start server
app.listen(port, () => {
  logger.info(`JPEG to AVIF conversion service started on port ${port}`, {
    port,
    nodeVersion: process.version,
    sharpVersion: sharp.versions.sharp,
    initialMemory: getMemoryUsage()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});