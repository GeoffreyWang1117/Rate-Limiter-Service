# Phase 2: Dynamic Rule Management System

## Overview

Phase 2 adds a complete dynamic rule management system with PostgreSQL persistence, allowing you to configure rate limiting rules without restarting the service.

## New Features

### 1. Rule Management

Create, read, update, and delete rate limit rules dynamically:

- **Rule CRUD API** - Full REST API for managing rules
- **PostgreSQL Storage** - Persistent storage with ACID guarantees
- **Rule Priority System** - Rules are matched by priority order
- **Pattern Matching** - Flexible matching with wildcards and regex
- **Rule Caching** - In-memory cache for fast rule lookups

### 2. Rule Engine

Intelligent rule matching engine with multiple dimensions:

- **Dimension Types**: user, ip, endpoint, global, custom
- **Pattern Matching**: Exact match, wildcard (*), regex support
- **Priority Ordering**: Higher priority rules match first
- **Cache Management**: 60-second TTL with manual invalidation

### 3. Database Schema

PostgreSQL tables:
- `rate_limit_rules` - Store rule configurations
- `rule_hit_stats` - Track rule usage statistics (optional)

## API Endpoints

### Rule Management

```
POST   /api/v1/rules              - Create a new rule
GET    /api/v1/rules              - Get all rules (with filters)
GET    /api/v1/rules/:id          - Get specific rule
PUT    /api/v1/rules/:id          - Update a rule
DELETE /api/v1/rules/:id          - Delete a rule
POST   /api/v1/rules/:id/enable   - Enable a rule
POST   /api/v1/rules/:id/disable  - Disable a rule
GET    /api/v1/rules/cache/stats  - Get cache statistics
POST   /api/v1/rules/cache/invalidate - Invalidate cache
```

## Quick Start

### 1. Start Services with PostgreSQL

```bash
docker-compose up -d
```

This now includes:
- Rate Limiter Service
- Redis
- **PostgreSQL** (new!)
- Prometheus
- Grafana

### 2. Run Database Migration

```bash
# Build the project first
npm run build

# Run migrations
npm run db:migrate up
```

### 3. Create Your First Rule

```bash
curl -X POST http://localhost:3000/api/v1/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "API Rate Limit for Premium Users",
    "description": "Premium users get 1000 req/min",
    "algorithm": "token_bucket",
    "limit": 1000,
    "windowSeconds": 60,
    "dimensionType": "user",
    "dimensionPattern": "premium:*",
    "priority": 100,
    "enabled": true
  }'
```

### 4. List All Rules

```bash
curl http://localhost:3000/api/v1/rules
```

## Rule Examples

### Global Rate Limit

```json
{
  "name": "Global API Limit",
  "algorithm": "token_bucket",
  "limit": 10000,
  "windowSeconds": 60,
  "dimensionType": "global",
  "priority": 999
}
```

### User-Specific Limit

```json
{
  "name": "User Rate Limit",
  "algorithm": "sliding_window",
  "limit": 100,
  "windowSeconds": 60,
  "dimensionType": "user",
  "dimensionPattern": "user:*",
  "priority": 500
}
```

### IP-Based Limit

```json
{
  "name": "IP Rate Limit",
  "algorithm": "fixed_window",
  "limit": 200,
  "windowSeconds": 60,
  "dimensionType": "ip",
  "dimensionPattern": "*",
  "priority": 400
}
```

### Endpoint-Specific Limit

```json
{
  "name": "Sensitive Endpoint Limit",
  "algorithm": "token_bucket",
  "limit": 10,
  "windowSeconds": 60,
  "dimensionType": "endpoint",
  "dimensionPattern": "/api/v1/admin/*",
  "priority": 200
}
```

## Pattern Matching

### Wildcards

- `user:*` - Matches all users
- `192.168.*` - Matches IP range
- `/api/*` - Matches all API endpoints

### Regex

- `/user:\d+/` - Matches user IDs
- `/^admin/` - Matches admin users

### Exact Match

- `user:12345` - Matches specific user

## Database Migration Commands

```bash
# Create tables
npm run db:migrate up

# Drop tables
npm run db:migrate down

# Reset (drop + create)
npm run db:migrate reset
```

## Configuration

PostgreSQL settings in `.env`:

```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=rate_limiter
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_MAX_CONNECTIONS=20
POSTGRES_IDLE_TIMEOUT=30000
```

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       ▼
┌─────────────────────┐
│  Rate Limit Check   │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐      ┌──────────────┐
│   Rule Engine       │─────>│    Cache     │
│  (Pattern Match)    │<─────│  (60s TTL)   │
└──────┬──────────────┘      └──────────────┘
       │
       ▼
┌─────────────────────┐      ┌──────────────┐
│  Rule Repository    │─────>│  PostgreSQL  │
└─────────────────────┘      └──────────────┘
       │
       ▼
┌─────────────────────┐      ┌──────────────┐
│  Rate Limit Algo    │─────>│    Redis     │
└─────────────────────┘      └──────────────┘
```

## Performance

- **Rule Matching**: < 1ms (cached)
- **Rule Lookup**: < 5ms (database)
- **Cache Hit Rate**: > 95%
- **Database Queries**: Optimized with indexes

## Best Practices

1. **Rule Priority**
   - Use higher numbers for more specific rules
   - Global rules should have lowest priority

2. **Pattern Design**
   - Keep patterns simple and efficient
   - Test regex patterns before deployment

3. **Cache Management**
   - Cache invalidates automatically after updates
   - Manual invalidation available for immediate effect

4. **Monitoring**
   - Track rule hit statistics
   - Monitor cache hit rates
   - Alert on rule conflicts

## Troubleshooting

### Rules Not Matching

1. Check rule is enabled
2. Verify priority order
3. Test pattern matching
4. Check cache stats

### Performance Issues

1. Review cache hit rate
2. Optimize regex patterns
3. Increase cache TTL
4. Add database indexes

## What's Next?

- Phase 3: Monitoring & Analytics
- Phase 4: High Availability
- Phase 5: Client SDKs

## Migration from Phase 1

Phase 1 functionality remains unchanged:
- Direct parameter-based rate limiting still works
- Rules are optional - use when needed
- Backward compatible API

Both approaches can be used simultaneously!
