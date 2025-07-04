import imagemin from 'imagemin';
import imageminAvif from 'imagemin-avif';
import Jimp from 'jimp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exiftool } from 'exiftool-vendored';
import jobService from './job-service.js';
import winston from 'winston';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ConversionWorker {
  constructor() {
    this.isRunning = false;
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

  async start() {
    if (this.isRunning) {
      this.logger.warn('Worker already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting conversion worker');

    while (this.isRunning) {
      try {
        const job = await jobService.getNextJob();
        if (!job) {
          continue; // Timeout, continue polling
        }

        await this.processJob(job);
      } catch (error) {
        this.logger.error('Worker error:', error.message);
        // Continue processing other jobs
      }
    }
  }

  async stop() {
    this.isRunning = false;
    this.logger.info('Stopping conversion worker');
  }

  async processJob(job) {
    const startTime = Date.now();
    this.logger.info(`Processing job ${job.id}`, { originalName: job.originalName });

    try {
      // Update job status to processing
      await jobService.updateJobStatus(job.id, { status: 'processing' });

      // Convert the base64 image data back to buffer
      const inputBuffer = Buffer.from(job.imageData, 'base64');
      
      // Create temporary files for metadata processing
      const tempDir = path.join(__dirname, '../../temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const originalName = path.parse(job.originalName).name;
      const tempOriginal = path.join(tempDir, `${job.id}_original.jpg`);
      const tempThumb = path.join(tempDir, `${job.id}_${originalName}_thumb.avif`);
      const tempFull = path.join(tempDir, `${job.id}_${originalName}.avif`);
      
      // Cleanup function
      const cleanupTempFiles = () => {
        [tempOriginal, tempThumb, tempFull].forEach(file => {
          try {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file);
            }
          } catch (cleanupError) {
            this.logger.warn('Failed to cleanup temp file', { jobId: job.id, file, error: cleanupError.message });
          }
        });
      };

      try {
        // Write original image to temp file for metadata extraction
        fs.writeFileSync(tempOriginal, inputBuffer);
        
        // Extract EXIF metadata from original JPEG
        let originalMetadata;
        try {
          originalMetadata = await exiftool.read(tempOriginal);
        } catch (exifError) {
          throw new Error(`Metadata extraction failed: ${exifError.message}`);
        }

        // Get image metadata using Jimp
        const image = await Jimp.read(inputBuffer);
        const metadata = {
          width: image.getWidth(),
          height: image.getHeight(),
          format: 'jpeg',
          channels: 3
        };

        // Helper function to add timeout to promises
        const withTimeout = (promise, timeoutMs, description) => {
          return Promise.race([
            promise,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs)
            )
          ]);
        };

        // Create thumbnail (200x200) with timeout
        const thumbnailBuffer = await withTimeout(
          (async () => {
            const thumbnail = image.clone().scaleToFit(200, 200);
            const thumbBuffer = await thumbnail.getBufferAsync(Jimp.MIME_JPEG);
            return await imagemin.buffer(thumbBuffer, {
              plugins: [
                imageminAvif({
                  quality: 80,
                  effort: 4
                })
              ]
            });
          })(),
          30000,
          'Thumbnail conversion'
        );

        // Create full-size AVIF with timeout
        const fullSizeBuffer = await withTimeout(
          imagemin.buffer(inputBuffer, {
            plugins: [
              imageminAvif({
                quality: 85,
                effort: 4
              })
            ]
          }),
          60000,
          'Full-size conversion'
        );

        // Write AVIF files to temp location
        fs.writeFileSync(tempThumb, thumbnailBuffer);
        fs.writeFileSync(tempFull, fullSizeBuffer);
        
        // Copy only the specific metadata we care about
        const metadataToPreserve = {};
        
        // Dimensions
        metadataToPreserve.ImageWidth = metadata.width;
        metadataToPreserve.ImageHeight = metadata.height;
        
        // Timestamp
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
        
        // Copy metadata to both AVIF files
        await withTimeout(
          exiftool.write(tempThumb, metadataToPreserve, ['-overwrite_original']),
          10000,
          'Thumbnail metadata copy'
        );
        
        await withTimeout(
          exiftool.write(tempFull, metadataToPreserve, ['-overwrite_original']),
          10000,
          'Full-size metadata copy'
        );
        
        // Read the final AVIF files with preserved metadata
        const finalThumbnailBuffer = fs.readFileSync(tempThumb);
        const finalFullSizeBuffer = fs.readFileSync(tempFull);
        
        // Clean up temp files
        cleanupTempFiles();
        
        const processingTime = Date.now() - startTime;

        // Update job with results
        await jobService.updateJobStatus(job.id, {
          status: 'completed',
          processingTime,
          results: {
            thumbnail: {
              filename: `${originalName}_thumb.avif`,
              data: finalThumbnailBuffer.toString('base64'),
              size: finalThumbnailBuffer.length,
              format: 'avif'
            },
            fullSize: {
              filename: `${originalName}.avif`,
              data: finalFullSizeBuffer.toString('base64'),
              size: finalFullSizeBuffer.length,
              format: 'avif'
            },
            originalSize: inputBuffer.length,
            metadataPreserved: true,
            preservedMetadata: {
              hasGPS: !!(originalMetadata.GPSLatitude && originalMetadata.GPSLongitude),
              hasTimestamp: !!(originalMetadata.DateTimeOriginal || originalMetadata.DateTime || originalMetadata.CreateDate),
              dimensions: `${metadata.width}x${metadata.height}`
            }
          }
        });

        this.logger.info(`Job ${job.id} completed successfully`, {
          processingTime,
          originalSize: inputBuffer.length,
          thumbnailSize: finalThumbnailBuffer.length,
          fullSizeSize: finalFullSizeBuffer.length
        });

      } catch (conversionError) {
        cleanupTempFiles();
        throw conversionError;
      }

    } catch (error) {
      this.logger.error(`Job ${job.id} failed:`, error.message);
      
      // Update job status to failed
      await jobService.updateJobStatus(job.id, {
        status: 'failed',
        error: error.message,
        processingTime: Date.now() - startTime
      });
    }
  }
}

export default ConversionWorker;
