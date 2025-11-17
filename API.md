# Rate Limiter Service - API Reference

## Overview

The Rate Limiter Service provides RESTful APIs for distributed rate limiting with support for multiple algorithms.

**Base URL:** `http://localhost:3000`

**Content-Type:** `application/json`

## Authentication

Currently, the service does not enforce authentication. In production, implement:
- JWT tokens
- API keys
- OAuth 2.0

## Rate Limiting

The service itself can be rate-limited. Rate limit information is provided in response headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 2024-11-17T12:00:00.000Z
Retry-After: 5
```

## Error Handling

All errors follow a consistent format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

### Common Error Codes

- `VALIDATION_ERROR` (400) - Invalid request parameters
- `NOT_FOUND` (404) - Resource not found
- `RATE_LIMIT_EXCEEDED` (429) - Rate limit exceeded
- `INTERNAL_SERVER_ERROR` (500) - Server error
- `REDIS_CONNECTION_ERROR` (503) - Redis unavailable

## API Endpoints

### 1. Check Rate Limit

Check if a request should be allowed or rate-limited.

```http
POST /api/v1/check-rate-limit
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | string | Yes | Unique rate limit key (1-256 chars) |
| identifier | string | Yes | User/client identifier (1-256 chars) |
| algorithm | string | No | Algorithm: `token_bucket`, `sliding_window`, `fixed_window` |
| limit | number | No | Max requests (1-1000000) |
| windowSeconds | number | No | Time window in seconds (1-86400) |
| endpoint | string | No | API endpoint being accessed |
| metadata | object | No | Additional metadata |

**Example Request:**

```json
{
  "key": "user:alice",
  "identifier": "alice@example.com",
  "algorithm": "token_bucket",
  "limit": 100,
  "windowSeconds": 60,
  "endpoint": "/api/v1/users",
  "metadata": {
    "ip": "192.168.1.100",
    "userAgent": "Mozilla/5.0"
  }
}
```

**Success Response (200 OK):**

```json
{
  "allowed": true,
  "limit": 100,
  "remaining": 99,
  "resetAt": 1700227200000
}
```

**Rate Limited Response (429 Too Many Requests):**

```json
{
  "allowed": false,
  "limit": 100,
  "remaining": 0,
  "resetAt": 1700227200000,
  "retryAfter": 5
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| allowed | boolean | Whether request is allowed |
| limit | number | Maximum requests allowed |
| remaining | number | Remaining requests in window |
| resetAt | number | Unix timestamp when limit resets |
| retryAfter | number | Seconds to wait before retry (if blocked) |

**Example cURL:**

```bash
curl -X POST http://localhost:3000/api/v1/check-rate-limit \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user:alice",
    "identifier": "alice@example.com",
    "algorithm": "token_bucket",
    "limit": 100,
    "windowSeconds": 60
  }'
```

---

### 2. Reset Rate Limit

Reset the rate limit counter for a specific key.

```http
POST /api/v1/reset
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | string | Yes | Rate limit key to reset |
| algorithm | string | Yes | Algorithm used for this key |

**Example Request:**

```json
{
  "key": "user:alice",
  "algorithm": "token_bucket"
}
```

**Success Response (200 OK):**

```json
{
  "success": true,
  "message": "Rate limit reset for key: user:alice"
}
```

**Example cURL:**

```bash
curl -X POST http://localhost:3000/api/v1/reset \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user:alice",
    "algorithm": "token_bucket"
  }'
```

---

### 3. Get Statistics

Retrieve current rate limit statistics for a key.

```http
POST /api/v1/stats
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| key | string | Yes | Rate limit key |
| algorithm | string | Yes | Algorithm used |

**Example Request:**

```json
{
  "key": "user:alice",
  "algorithm": "token_bucket"
}
```

**Success Response (200 OK):**

```json
{
  "key": "user:alice",
  "algorithm": "token_bucket",
  "currentCount": 50,
  "resetAt": 1700227200000
}
```

**Not Found Response (404):**

```json
{
  "error": "No stats found for this key"
}
```

**Example cURL:**

```bash
curl -X POST http://localhost:3000/api/v1/stats \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user:alice",
    "algorithm": "token_bucket"
  }'
```

---

### 4. Health Check

Check the overall health of the service.

```http
GET /health
```

**Success Response (200 OK):**

```json
{
  "status": "healthy",
  "timestamp": "2024-11-17T12:00:00.000Z",
  "service": "rate-limiter-service",
  "version": "1.0.0",
  "checks": {
    "redis": "up"
  }
}
```

**Unhealthy Response (503 Service Unavailable):**

```json
{
  "status": "unhealthy",
  "timestamp": "2024-11-17T12:00:00.000Z",
  "service": "rate-limiter-service",
  "version": "1.0.0",
  "checks": {
    "redis": "down"
  }
}
```

---

### 5. Readiness Probe

Kubernetes readiness probe endpoint.

```http
GET /health/ready
```

**Ready Response (200 OK):**

```json
{
  "ready": true
}
```

**Not Ready Response (503):**

```json
{
  "ready": false,
  "reason": "Redis not available"
}
```

---

### 6. Liveness Probe

Kubernetes liveness probe endpoint.

```http
GET /health/live
```

**Response (200 OK):**

```json
{
  "alive": true
}
```

---

### 7. Prometheus Metrics

Prometheus-compatible metrics endpoint for monitoring.

```http
GET /metrics
```

**Response:** Prometheus text format

**Available Metrics:**

- `rate_limiter_requests_total` - Counter: Total rate limit check requests
- `rate_limiter_blocked_requests_total` - Counter: Blocked requests
- `rate_limiter_check_latency_seconds` - Histogram: Check latency
- `rate_limiter_redis_latency_seconds` - Histogram: Redis latency
- `rate_limiter_redis_errors_total` - Counter: Redis errors
- `rate_limiter_api_requests_total` - Counter: API requests by endpoint
- `rate_limiter_active_keys` - Gauge: Active rate limit keys

---

## Usage Examples

### Node.js / JavaScript

```javascript
const axios = require('axios');

async function checkRateLimit(userId) {
  try {
    const response = await axios.post('http://localhost:3000/api/v1/check-rate-limit', {
      key: `user:${userId}`,
      identifier: userId,
      algorithm: 'token_bucket',
      limit: 100,
      windowSeconds: 60
    });

    if (response.data.allowed) {
      console.log('Request allowed');
      console.log(`Remaining: ${response.data.remaining}`);
    } else {
      console.log('Rate limited');
      console.log(`Retry after: ${response.data.retryAfter} seconds`);
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

checkRateLimit('alice');
```

### Python

```python
import requests

def check_rate_limit(user_id):
    url = 'http://localhost:3000/api/v1/check-rate-limit'
    payload = {
        'key': f'user:{user_id}',
        'identifier': user_id,
        'algorithm': 'token_bucket',
        'limit': 100,
        'windowSeconds': 60
    }

    response = requests.post(url, json=payload)
    data = response.json()

    if data['allowed']:
        print(f"Request allowed. Remaining: {data['remaining']}")
    else:
        print(f"Rate limited. Retry after: {data['retryAfter']} seconds")

check_rate_limit('alice')
```

### Go

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "net/http"
)

type RateLimitRequest struct {
    Key           string `json:"key"`
    Identifier    string `json:"identifier"`
    Algorithm     string `json:"algorithm"`
    Limit         int    `json:"limit"`
    WindowSeconds int    `json:"windowSeconds"`
}

type RateLimitResponse struct {
    Allowed    bool  `json:"allowed"`
    Limit      int   `json:"limit"`
    Remaining  int   `json:"remaining"`
    ResetAt    int64 `json:"resetAt"`
    RetryAfter int   `json:"retryAfter,omitempty"`
}

func checkRateLimit(userID string) error {
    req := RateLimitRequest{
        Key:           fmt.Sprintf("user:%s", userID),
        Identifier:    userID,
        Algorithm:     "token_bucket",
        Limit:         100,
        WindowSeconds: 60,
    }

    jsonData, _ := json.Marshal(req)
    resp, err := http.Post(
        "http://localhost:3000/api/v1/check-rate-limit",
        "application/json",
        bytes.NewBuffer(jsonData),
    )
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    var result RateLimitResponse
    json.NewDecoder(resp.Body).Decode(&result)

    if result.Allowed {
        fmt.Printf("Request allowed. Remaining: %d\n", result.Remaining)
    } else {
        fmt.Printf("Rate limited. Retry after: %d seconds\n", result.RetryAfter)
    }

    return nil
}

func main() {
    checkRateLimit("alice")
}
```

## Best Practices

1. **Choose the Right Algorithm**
   - Use Token Bucket for most use cases
   - Use Sliding Window for strict requirements
   - Use Fixed Window for high performance

2. **Key Design**
   - Use hierarchical keys: `user:123`, `ip:192.168.1.1`
   - Include relevant dimensions
   - Keep keys under 256 characters

3. **Error Handling**
   - Always handle 429 responses
   - Implement exponential backoff
   - Respect `Retry-After` header

4. **Monitoring**
   - Track rate limit hits
   - Monitor `remaining` values
   - Set up alerts for frequent blocking

5. **Testing**
   - Test rate limit behavior
   - Verify algorithm selection
   - Check boundary conditions
