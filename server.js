import express from 'express';
import multer from 'multer';
import imagemin from 'imagemin';
import imageminAvif from 'imagemin-avif';
import Jimp from 'jimp';
import winston from 'winston';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exiftool } from 'exiftool-vendored';

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
    
    // Create temporary files for metadata processing
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempOriginal = path.join(tempDir, `${requestId}_original.jpg`);
    const tempThumb = path.join(tempDir, `${requestId}_thumb.avif`);
    const tempFull = path.join(tempDir, `${requestId}_full.avif`);
    
    // Write original image to temp file for metadata extraction
    fs.writeFileSync(tempOriginal, inputBuffer);
    
    // Extract EXIF metadata from original JPEG
    let originalMetadata;
    try {
      originalMetadata = await exiftool.read(tempOriginal);
      logger.info('Original metadata extracted', {
        requestId,
        hasGPS: !!(originalMetadata.GPSLatitude && originalMetadata.GPSLongitude),
        hasExif: !!(originalMetadata.Make || originalMetadata.Model || originalMetadata.DateTimeOriginal),
        cameraMake: originalMetadata.Make,
        cameraModel: originalMetadata.Model,
        dateTaken: originalMetadata.DateTimeOriginal
      });
    } catch (exifError) {
      // If metadata extraction fails, fail the entire conversion
      logger.error('Metadata extraction failed - aborting conversion', {
        requestId,
        error: exifError.message
      });
      
      // Cleanup temp files
      [tempOriginal].forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
      
      return res.status(500).json({
        success: false,
        requestId,
        error: 'Metadata extraction failed - conversion aborted to preserve data integrity',
        processingTime: Date.now() - startTime
      });
    }
    
    // Get image metadata using Jimp
    const image = await Jimp.read(inputBuffer);
    
    const metadata = {
      width: image.getWidth(),
      height: image.getHeight(),
      format: 'jpeg',
      channels: 3
    };
    
    logger.info('Image metadata extracted', {
      requestId,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      channels: metadata.channels
    });

    // Process both images concurrently using imagemin + jimp
    const [thumbnailBuffer, fullSizeBuffer] = await Promise.all([
      // Create thumbnail (200x200)
      (async () => {
        const thumbnail = image.clone().scaleToFit(200, 200);
        const thumbBuffer = await thumbnail.getBufferAsync(Jimp.MIME_JPEG);
        return await imagemin.buffer(thumbBuffer, {
          plugins: [
            imageminAvif({
              quality: 80,
              effort: 6
            })
          ]
        });
      })(),
      
      // Create full-size AVIF
      (async () => {
        return await imagemin.buffer(inputBuffer, {
          plugins: [
            imageminAvif({
              quality: 85,
              effort: 6
            })
          ]
        });
      })()
    ]);

    // Write AVIF files to temp location
    fs.writeFileSync(tempThumb, thumbnailBuffer);
    fs.writeFileSync(tempFull, fullSizeBuffer);
    
    // Copy only the specific metadata we care about
    try {
      // Extract only dimensions, timestamp, and GPS location
      const metadataToPreserve = {};
      
      // Dimensions (from image, not EXIF since we already have them)
      metadataToPreserve.ImageWidth = metadata.width;
      metadataToPreserve.ImageHeight = metadata.height;
      
      // Timestamp - try multiple possible fields
      if (originalMetadata.DateTimeOriginal) {
        metadataToPreserve.DateTimeOriginal = originalMetadata.DateTimeOriginal;
      } else if (originalMetadata.DateTime) {
        metadataToPreserve.DateTime = originalMetadata.DateTime;
      } else if (originalMetadata.CreateDate) {
        metadataToPreserve.CreateDate = originalMetadata.CreateDate;
      }
      
      // GPS location
      if (originalMetadata.GPSLatitude && originalMetadata.GPSLongitude) {
        metadataToPreserve.GPSLatitude = originalMetadata.GPSLatitude;
        metadataToPreserve.GPSLongitude = originalMetadata.GPSLongitude;
        metadataToPreserve.GPSLatitudeRef = originalMetadata.GPSLatitudeRef;
        metadataToPreserve.GPSLongitudeRef = originalMetadata.GPSLongitudeRef;
      }
      
      // Copy metadata to thumbnail AVIF
      await exiftool.write(tempThumb, metadataToPreserve, ['-overwrite_original']);
      
      // Copy metadata to full-size AVIF
      await exiftool.write(tempFull, metadataToPreserve, ['-overwrite_original']);
      
      logger.info('Metadata successfully copied to AVIF files', {
        requestId,
        preservedFields: Object.keys(metadataToPreserve).length,
        dimensions: `${metadata.width}x${metadata.height}`,
        hasGPS: !!(originalMetadata.GPSLatitude && originalMetadata.GPSLongitude),
        hasTimestamp: !!(originalMetadata.DateTimeOriginal || originalMetadata.DateTime || originalMetadata.CreateDate)
      });
      
      // Read the final AVIF files with preserved metadata
      const finalThumbnailBuffer = fs.readFileSync(tempThumb);
      const finalFullSizeBuffer = fs.readFileSync(tempFull);
      
      // Cleanup temp files
      [tempOriginal, tempThumb, tempFull].forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
      
      const memoryAfter = getMemoryUsage();
      const processingTime = Date.now() - startTime;

      // Log conversion results
      logger.info('Conversion completed successfully with metadata preserved', {
        requestId,
        processingTime,
        memoryBefore,
        memoryAfter,
        memoryDelta: {
          rss: memoryAfter.rss - memoryBefore.rss,
          heapUsed: memoryAfter.heapUsed - memoryBefore.heapUsed
        },
        originalSize: inputBuffer.length,
        thumbnailSize: finalThumbnailBuffer.length,
        fullSizeSize: finalFullSizeBuffer.length,
        compressionRatio: {
          thumbnail: Math.round((1 - finalThumbnailBuffer.length / inputBuffer.length) * 100),
          fullSize: Math.round((1 - finalFullSizeBuffer.length / inputBuffer.length) * 100)
        },
        metadataPreserved: true
      });

      // Clear input buffer from memory
      inputBuffer.fill(0);

      // Return both images as base64 encoded strings with metadata preserved
      res.json({
        success: true,
        requestId,
        processingTime,
        thumbnail: {
          data: finalThumbnailBuffer.toString('base64'),
          size: finalThumbnailBuffer.length,
          format: 'avif'
        },
        fullSize: {
          data: finalFullSizeBuffer.toString('base64'),
          size: finalFullSizeBuffer.length,
          format: 'avif'
        },
        originalSize: inputBuffer.length,
        metadataPreserved: true,
        preservedMetadata: {
          hasGPS: !!(originalMetadata.GPSLatitude && originalMetadata.GPSLongitude),
          hasExif: !!(originalMetadata.Make || originalMetadata.Model || originalMetadata.DateTimeOriginal),
          cameraMake: originalMetadata.Make,
          cameraModel: originalMetadata.Model,
          dateTaken: originalMetadata.DateTimeOriginal
        },
        memoryUsage: {
          before: memoryBefore,
          after: memoryAfter
        }
      });
      
    } catch (metadataError) {
      // If metadata copying fails, fail the entire conversion
      logger.error('Metadata copying failed - aborting conversion', {
        requestId,
        error: metadataError.message
      });
      
      // Cleanup temp files
      [tempOriginal, tempThumb, tempFull].forEach(file => {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      });
      
      return res.status(500).json({
        success: false,
        requestId,
        error: 'Metadata copying failed - conversion aborted to preserve data integrity',
        processingTime: Date.now() - startTime
      });
    }

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

// Initialize imagemin for AVIF conversion
logger.info('AVIF converter initialized');
logger.info('AVIF support: YES (via imagemin-avif)');

// Start server
app.listen(port, () => {
  logger.info(`JPEG to AVIF conversion service started on port ${port}`, {
    port,
    nodeVersion: process.version,
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