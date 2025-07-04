# JPEG to AVIF Conversion Microservice

A memory-efficient Node.js microservice that converts JPEG images to AVIF format, always generating both thumbnails (200x200px) and full-size images optimized for service-to-service communication.

## Features

- **Memory Efficient**: Uses streams and concurrent processing for optimal memory usage
- **Dual Output**: Always generates both thumbnail (200x200px) and full-size AVIF images
- **Optimized for APIs**: Designed for service-to-service communication with JSON responses
- **Comprehensive Logging**: Detailed logs including memory usage before/after conversion
- **Health Monitoring**: Built-in health check endpoint
- **Docker Ready**: Optimized for containerized deployment in Kubernetes
- **Error Handling**: Robust error handling with proper HTTP status codes

## API Endpoints

### POST /convert
Converts a JPEG image and returns both thumbnail and full-size AVIF images as base64 encoded strings.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Body: Form field `image` with JPEG file

**Response:**
```json
{
  "success": true,
  "requestId": "req_1234567890_abc123",
  "processingTime": 1500,
  "thumbnail": {
    "data": "base64-encoded-avif-data",
    "size": 12345,
    "format": "avif"
  },
  "fullSize": {
    "data": "base64-encoded-avif-data",
    "size": 67890,
    "format": "avif"
  },
  "originalSize": 100000,
  "memoryUsage": {
    "before": { "rss": 45.2, "heapUsed": 23.1 },
    "after": { "rss": 48.7, "heapUsed": 25.6 }
  }
}
```

### GET /health
Health check endpoint for monitoring and load balancers.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-07-04T12:00:00.000Z",
  "memory": {
    "rss": 45.2,
    "heapTotal": 30.5,
    "heapUsed": 23.1,
    "external": 5.8
  }
}
```

## Example Usage

### Using curl
```bash
curl -X POST \
  -F "image=@example.jpg" \
  http://localhost:3000/convert
```

### Using JavaScript (Node.js)
```javascript
const FormData = require('form-data');
const fs = require('fs');

const form = new FormData();
form.append('image', fs.createReadStream('example.jpg'));

fetch('http://localhost:3000/convert', {
  method: 'POST',
  body: form
})
.then(response => response.json())
.then(data => {
  console.log('Conversion completed:', data);
  // data.thumbnail.data contains base64 encoded thumbnail
  // data.fullSize.data contains base64 encoded full-size image
});
```

### Using Python (requests)
```python
import requests

with open('example.jpg', 'rb') as f:
    files = {'image': f}
    response = requests.post('http://localhost:3000/convert', files=files)
    data = response.json()
    
    if data['success']:
        thumbnail_base64 = data['thumbnail']['data']
        fullsize_base64 = data['fullSize']['data']
        print(f"Processing time: {data['processingTime']}ms")
```

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment (development/production)

### Memory Limits

- Maximum file size: 50MB
- Memory storage for efficient streaming
- Automatic garbage collection triggers

## Logging

The service creates detailed logs in the `logs/` directory:

- `conversion.log`: All conversion activities with memory usage
- `error.log`: Error-specific logs

Log entries include:
- Request ID for tracking
- Memory usage before/after conversion
- Processing time
- File sizes and compression ratios
- Error details with stack traces

## Kubernetes Deployment

The service is optimized for Kubernetes with:

- Health check endpoint for liveness/readiness probes
- Graceful shutdown handling
- Memory-efficient processing
- Non-root user for security
- Proper error handling and logging

Example Kubernetes deployment:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jpeg2avif-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: jpeg2avif-service
  template:
    metadata:
      labels:
        app: jpeg2avif-service
    spec:
      containers:
      - name: jpeg2avif-service
        image: jpeg2avif-service:latest
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
```

## Memory Optimization Features

1. **Stream Processing**: Uses Sharp's streaming capabilities
2. **Buffer Management**: Efficient buffer handling and cleanup
3. **Garbage Collection**: Triggers GC after processing
4. **Concurrent Processing**: Processes thumbnail and full-size images simultaneously
5. **Memory Monitoring**: Tracks memory usage throughout the process

## Performance Considerations

- AVIF quality settings balanced for file size vs. quality
- Sharp effort level optimized for processing speed
- Concurrent processing for better throughput
- Memory-efficient multer configuration
- Proper error handling to prevent memory leaks
