# Autonomous n8n Integration SDK Pipeline
## Architecture for VPS Deployment with OpenClaw/Kimi Claw

---

## 1. OVERVIEW

**Goal**: Crawl n8n's 1,000+ integrations (400+ core + 600+ community packages), discover API/WebSocket documentation for each vendor, detect OpenAPI/AsyncAPI/GraphQL specs, download them, and auto-generate SDKs where none exist — all running autonomously on a VPS with state tracking.

**n8n Integration Landscape (2026)**:
- 400+ built-in core nodes (official)
- 600+ community node packages on npm (5,800+ indexed community nodes)
- Total: 1,000+ pre-built integrations
- Source: n8n.io/integrations directory + npm registry (`n8n-community-node-package` keyword)

---

## 2. SYSTEM ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VPS (Docker Host)                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Crawler    │  │   Doc Scout  │  │   Spec Miner │  │  SDK Generator   │  │
│  │   (Python)   │  │   (Python)   │  │   (Python)   │  │  (OpenAPI Gen) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                 │                   │            │
│         └─────────────────┴─────────────────┴───────────────────┘            │
│                                     │                                        │
│                           ┌─────────┴─────────┐                              │
│                           │   State DB        │                              │
│                           │   (PostgreSQL)    │                              │
│                           └─────────┬─────────┘                              │
│                                     │                                        │
│                           ┌─────────┴─────────┐                              │
│                           │   Kimi Claw /     │                              │
│                           │   OpenClaw Agent  │                              │
│                           │   (Autonomous)    │                              │
│                           └───────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. STATE MANAGEMENT TABLE SCHEMA

### Table: `integration_state`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Unique ID |
| `node_name` | VARCHAR(255) | n8n node name (e.g., `n8n-nodes-stripe`) |
| `app_name` | VARCHAR(255) | Human app name (e.g., `Stripe`) |
| `node_type` | ENUM | `core` or `community` |
| `npm_package` | VARCHAR(255) | NPM package name (community nodes) |
| `github_url` | TEXT | Source repo if available |
| `docs_url` | TEXT | Discovered developer docs URL |
| `api_type` | ENUM | `rest`, `graphql`, `websocket`, `grpc`, `soap`, `unknown` |
| `spec_format` | ENUM | `openapi3`, `openapi2`, `asyncapi`, `graphql_schema`, `postman`, `none` |
| `spec_url` | TEXT | Direct URL to spec file |
| `spec_local_path` | TEXT | Path to downloaded spec on disk |
| `spec_downloaded_at` | TIMESTAMP | When spec was fetched |
| `sdk_exists` | BOOLEAN | Whether vendor provides official SDK |
| `sdk_languages` | JSONB | Available SDKs (e.g., `["node","python","go"]`) |
| `sdk_generated` | BOOLEAN | Whether we generated an SDK |
| `sdk_gen_language` | VARCHAR(50) | Language of generated SDK |
| `sdk_output_path` | TEXT | Local path to generated SDK |
| `sdk_quality_score` | FLOAT | 0-1 score from linter/tests |
| `n8n_node_exists` | BOOLEAN | Whether n8n already has a node |
| `status` | ENUM | `pending`, `docs_found`, `spec_found`, `spec_downloaded`, `sdk_generated`, `sdk_tested`, `completed`, `failed`, `blocked` |
| `error_log` | TEXT | Last error message |
| `attempt_count` | INT | Retry counter |
| `last_attempted_at` | TIMESTAMP | Last processing time |
| `priority` | INT | 1-10 (higher = process first) |
| `tags` | JSONB | Categories, keywords |
| `created_at` | TIMESTAMP | Record creation |
| `updated_at` | TIMESTAMP | Last update |

### Table: `spec_discovery_log`

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Unique ID |
| `integration_id` | INT FK | References integration_state |
| `discovery_method` | ENUM | `swagger_ui`, `well_known`, `sitemap`, `github`, `npm_readme`, `manual` |
| `url_tested` | TEXT | URL that was probed |
| `response_status` | INT | HTTP status code |
| `content_type` | VARCHAR(255) | Detected MIME type |
| `found_spec` | BOOLEAN | Whether spec was found at this URL |
| `probed_at` | TIMESTAMP | When URL was tested |

---

## 4. PHASE 1: CRAWL n8n INTEGRATIONS

### 4.1 Core Nodes Crawler

Scrape `https://n8n.io/integrations` and `https://docs.n8n.io/integrations/builtin/`.

```python
# crawler_n8n_core.py
import requests
from bs4 import BeautifulSoup
import psycopg2
from urllib.parse import urljoin

DB_CONFIG = {
    "dbname": "n8n_sdk_pipeline",
    "user": "pipeline",
    "password": "your_secure_password",
    "host": "postgres",
    "port": 5432
}

def fetch_core_nodes():
    url = "https://n8n.io/integrations"
    headers = {"User-Agent": "Mozilla/5.0 (compatible; SDKBot/1.0)"}
    resp = requests.get(url, headers=headers, timeout=30)
    soup = BeautifulSoup(resp.text, "html.parser")

    nodes = []
    for card in soup.select("[data-testid='integration-card'], .integration-item, .node-card"):
        name = card.select_one("h3, .title, .node-name")
        link = card.select_one("a[href^='/nodes/'], a[href^='/integrations/']")
        if name and link:
            nodes.append({
                "node_name": name.get_text(strip=True),
                "app_name": name.get_text(strip=True),
                "node_type": "core",
                "docs_url": urljoin("https://n8n.io", link["href"]),
                "status": "pending",
                "priority": 5
            })
    return nodes

def fetch_community_nodes():
    url = "https://registry.npmjs.org/-/v1/search"
    nodes = []
    page = 0
    while True:
        params = {
            "text": "keywords:n8n-community-node-package",
            "size": 250,
            "from": page * 250
        }
        resp = requests.get(url, params=params, timeout=30)
        data = resp.json()
        packages = data.get("objects", [])
        if not packages:
            break
        for pkg in packages:
            p = pkg["package"]
            nodes.append({
                "node_name": p["name"],
                "app_name": p.get("name", "").replace("n8n-nodes-", "").replace("-", " ").title(),
                "node_type": "community",
                "npm_package": p["name"],
                "docs_url": p.get("links", {}).get("homepage", p.get("links", {}).get("repository", "")),
                "github_url": p.get("links", {}).get("repository", ""),
                "status": "pending",
                "priority": 3
            })
        page += 1
        if len(packages) < 250:
            break
    return nodes

def save_to_db(nodes):
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    for node in nodes:
        cur.execute("""
            INSERT INTO integration_state 
            (node_name, app_name, node_type, npm_package, docs_url, github_url, status, priority, tags)
            VALUES (%(node_name)s, %(app_name)s, %(node_type)s, %(npm_package)s, 
                    %(docs_url)s, %(github_url)s, %(status)s, %(priority)s, %(tags)s)
            ON CONFLICT (node_name) DO UPDATE SET
                app_name = EXCLUDED.app_name,
                docs_url = EXCLUDED.docs_url,
                github_url = EXCLUDED.github_url,
                updated_at = NOW()
        """, {**node, "tags": "{}"})
    conn.commit()
    cur.close()
    conn.close()

if __name__ == "__main__":
    core = fetch_core_nodes()
    community = fetch_community_nodes()
    save_to_db(core + community)
    print(f"Inserted/updated {len(core)} core + {len(community)} community nodes")
```

---

## 5. PHASE 2: API DOC & SPEC DISCOVERY

### 5.1 Doc Discovery Engine

```python
# doc_scout.py
import requests
import psycopg2
import json
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

DB_CONFIG = {
    "dbname": "n8n_sdk_pipeline",
    "user": "pipeline",
    "password": "your_secure_password",
    "host": "postgres",
    "port": 5432
}

# Common OpenAPI/Swagger/AsyncAPI discovery paths
SPEC_PATHS = [
    "/openapi.json", "/openapi.yaml", "/openapi.yml",
    "/swagger.json", "/swagger.yaml", "/swagger.yml",
    "/v2/api-docs", "/v3/api-docs",
    "/api-docs", "/api/docs",
    "/.well-known/openapi.json", "/.well-known/openapi.yaml",
    "/api/swagger.json", "/api/v1/swagger.json",
    "/swagger-ui.html", "/swagger-ui/",
    "/api/reference/openapi.json",
    "/docs/api/openapi.json", "/developer/openapi.json",
    "/asyncapi.json", "/asyncapi.yaml",
    "/graphql", "/api/graphql",
    "/websocket", "/ws", "/socket.io",
    "/api", "/developers", "/docs", "/documentation",
    "/api-reference", "/api-reference.json"
]

def infer_base_url(integration):
    urls_to_try = []
    if integration.get("github_url"):
        urls_to_try.append(integration["github_url"])
    if integration.get("docs_url"):
        urls_to_try.append(integration["docs_url"])
    if integration.get("npm_package"):
        try:
            resp = requests.get(f"https://registry.npmjs.org/{integration['npm_package']}", timeout=10)
            data = resp.json()
            latest = data.get("dist-tags", {}).get("latest")
            if latest:
                homepage = data.get("versions", {}).get(latest, {}).get("homepage", "")
                if homepage:
                    urls_to_try.append(homepage)
        except:
            pass
    return urls_to_try

def probe_spec_urls(base_urls):
    found_specs = []
    for base in base_urls:
        parsed = urlparse(base)
        if not parsed.netloc:
            continue
        for path in SPEC_PATHS:
            test_url = urljoin(base, path)
            try:
                resp = requests.get(test_url, timeout=15, headers={
                    "Accept": "application/json, application/x-yaml, text/html",
                    "User-Agent": "Mozilla/5.0 (compatible; SDKBot/1.0)"
                })
                content_type = resp.headers.get("Content-Type", "").lower()
                if resp.status_code == 200:
                    spec_format = None
                    text_sample = resp.text[:500]
                    if "openapi" in text_sample or "swagger" in text_sample:
                        spec_format = "openapi3" if "3." in text_sample[:100] else "openapi2"
                    elif "asyncapi" in text_sample:
                        spec_format = "asyncapi"
                    elif "graphql" in content_type or "__schema" in text_sample:
                        spec_format = "graphql_schema"

                    if spec_format:
                        found_specs.append({
                            "url": test_url,
                            "format": spec_format,
                            "status": resp.status_code,
                            "content_type": content_type
                        })
            except Exception as e:
                continue
    return found_specs

def discover_from_github(github_url):
    if not github_url or "github.com" not in github_url:
        return []
    raw_base = github_url.replace("github.com", "raw.githubusercontent.com") + "/main"
    found = []
    for filename in ["openapi.json", "openapi.yaml", "openapi.yml", "swagger.json", "swagger.yaml"]:
        try:
            url = f"{raw_base}/{filename}"
            resp = requests.get(url, timeout=10)
            if resp.status_code == 200:
                fmt = "openapi3" if "3." in resp.text[:100] else "openapi2"
                found.append({"url": url, "format": fmt, "source": "github_root"})
        except:
            pass
    for filename in ["openapi.json", "openapi.yaml"]:
        try:
            url = f"{raw_base}/docs/{filename}"
            resp = requests.get(url, timeout=10)
            if resp.status_code == 200:
                fmt = "openapi3" if "3." in resp.text[:100] else "openapi2"
                found.append({"url": url, "format": fmt, "source": "github_docs"})
        except:
            pass
    return found

def process_pending_integrations():
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, node_name, npm_package, docs_url, github_url 
        FROM integration_state 
        WHERE status = 'pending' 
        ORDER BY priority DESC, created_at ASC
        LIMIT 50
    """)
    rows = cur.fetchall()

    for row in rows:
        int_id, name, npm_pkg, docs_url, github_url = row
        integration = {
            "node_name": name,
            "npm_package": npm_pkg,
            "docs_url": docs_url,
            "github_url": github_url
        }

        base_urls = infer_base_url(integration)
        specs = probe_spec_urls(base_urls)
        gh_specs = discover_from_github(github_url)
        specs.extend(gh_specs)

        if specs:
            best = specs[0]
            cur.execute("""
                UPDATE integration_state 
                SET spec_url = %s, 
                    spec_format = %s,
                    status = 'spec_found',
                    docs_url = COALESCE(docs_url, %s),
                    updated_at = NOW()
                WHERE id = %s
            """, (best["url"], best["format"], base_urls[0] if base_urls else None, int_id))

            for spec in specs:
                cur.execute("""
                    INSERT INTO spec_discovery_log 
                    (integration_id, discovery_method, url_tested, response_status, found_spec)
                    VALUES (%s, %s, %s, %s, %s)
                """, (int_id, spec.get("source", "probe"), spec["url"], 200, True))
        else:
            cur.execute("""
                UPDATE integration_state 
                SET status = 'docs_found',
                    attempt_count = attempt_count + 1,
                    updated_at = NOW()
                WHERE id = %s
            """, (int_id,))

        conn.commit()

    cur.close()
    conn.close()

if __name__ == "__main__":
    process_pending_integrations()
```

---

## 6. PHASE 3: SPEC DOWNLOAD & VALIDATION

```python
# spec_downloader.py
import requests
import os
import yaml
import json
import psycopg2
from pathlib import Path

DB_CONFIG = {
    "dbname": "n8n_sdk_pipeline",
    "user": "pipeline",
    "password": "your_secure_password",
    "host": "postgres",
    "port": 5432
}
SPECS_DIR = "/data/specs"

def download_spec(integration_id, spec_url, spec_format):
    try:
        resp = requests.get(spec_url, timeout=30, headers={
            "User-Agent": "Mozilla/5.0 (compatible; SDKBot/1.0)"
        })
        resp.raise_for_status()

        content = resp.text
        ext = "json" if content.strip().startswith("{") else "yaml"

        if ext == "json":
            data = json.loads(content)
        else:
            data = yaml.safe_load(content)

        if "paths" not in data and "channels" not in data and "__schema" not in str(data):
            return None, "Invalid spec: missing paths/channels"

        safe_name = str(integration_id).zfill(5)
        out_dir = Path(SPECS_DIR) / safe_name
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"spec.{ext}"
        out_path.write_text(content, encoding="utf-8")

        return str(out_path), None
    except Exception as e:
        return None, str(e)

def process_spec_downloads():
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, spec_url, spec_format 
        FROM integration_state 
        WHERE status = 'spec_found' 
        AND spec_url IS NOT NULL
        LIMIT 20
    """)

    for row in cur.fetchall():
        int_id, spec_url, spec_format = row
        path, error = download_spec(int_id, spec_url, spec_format)

        if path:
            cur.execute("""
                UPDATE integration_state 
                SET spec_local_path = %s,
                    spec_downloaded_at = NOW(),
                    status = 'spec_downloaded',
                    updated_at = NOW()
                WHERE id = %s
            """, (path, int_id))
        else:
            cur.execute("""
                UPDATE integration_state 
                SET error_log = %s,
                    attempt_count = attempt_count + 1,
                    status = 'failed',
                    updated_at = NOW()
                WHERE id = %s
            """, (error, int_id))
        conn.commit()

    cur.close()
    conn.close()

if __name__ == "__main__":
    process_spec_downloads()
```

---

## 7. PHASE 4: SDK GENERATION

### 7.1 OpenAPI Generator Pipeline

```python
# sdk_generator.py
import subprocess
import os
import psycopg2
from pathlib import Path

DB_CONFIG = {
    "dbname": "n8n_sdk_pipeline",
    "user": "pipeline",
    "password": "your_secure_password",
    "host": "postgres",
    "port": 5432
}
SDKS_DIR = "/data/sdks"
GENERATOR_IMAGE = "openapitools/openapi-generator-cli:latest"

def generate_sdk(spec_path, output_dir, language="typescript", package_name=None):
    if not package_name:
        package_name = Path(output_dir).name

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{os.path.abspath(os.path.dirname(spec_path))}:/specs",
        "-v", f"{os.path.abspath(output_dir)}:/output",
        GENERATOR_IMAGE,
        "generate",
        "-i", f"/specs/{Path(spec_path).name}",
        "-g", language,
        "-o", "/output",
        "--additional-properties=supportsES6=true,npmName=" + package_name
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    return result.returncode == 0, result.stdout, result.stderr

def process_sdk_generation():
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, node_name, spec_local_path, spec_format
        FROM integration_state 
        WHERE status = 'spec_downloaded'
        AND sdk_generated = FALSE
        AND spec_format IN ('openapi3', 'openapi2')
        ORDER BY priority DESC
        LIMIT 10
    """)

    for row in cur.fetchall():
        int_id, node_name, spec_path, spec_format = row
        safe_name = str(int_id).zfill(5)
        output_dir = Path(SDKS_DIR) / safe_name / "typescript"
        output_dir.mkdir(parents=True, exist_ok=True)

        success, stdout, stderr = generate_sdk(
            spec_path, 
            str(output_dir), 
            language="typescript-fetch",
            package_name=f"@{safe_name}/sdk"
        )

        if success:
            cur.execute("""
                UPDATE integration_state 
                SET sdk_generated = TRUE,
                    sdk_gen_language = 'typescript',
                    sdk_output_path = %s,
                    status = 'sdk_generated',
                    updated_at = NOW()
                WHERE id = %s
            """, (str(output_dir), int_id))
        else:
            cur.execute("""
                UPDATE integration_state 
                SET error_log = %s,
                    attempt_count = attempt_count + 1,
                    status = 'failed',
                    updated_at = NOW()
                WHERE id = %s
            """, (stderr[:2000], int_id))
        conn.commit()

    cur.close()
    conn.close()

if __name__ == "__main__":
    process_sdk_generation()
```

### 7.2 Multi-Language Generation Matrix

| Priority | Language | Generator | Use Case |
|----------|----------|-----------|----------|
| 1 | TypeScript | `typescript-fetch` | n8n nodes are TS |
| 2 | Python | `python` | AI/ML workflows |
| 3 | Go | `go` | Infrastructure tools |
| 4 | Java | `java` | Enterprise connectors |

---

## 8. PHASE 5: KIMI CLAW / OPENCLAW AUTONOMOUS CODING

### 8.1 Integration Strategy

Kimi Claw provides 24/7 cloud-hosted OpenClaw agents with 5,000+ skills via browser — no VPS needed for the agent itself, but you can bridge it to your pipeline.

**Local OpenClaw on VPS** (alternative to Kimi Claw cloud):

```yaml
# docker-compose.openclaw.yml
version: "3.8"
services:
  openclaw:
    image: significantgravitas/openclaw:master
    container_name: openclaw-agent
    ports:
      - "8000:8000"
    volumes:
      - ./openclaw-data:/app/data
      - /data/sdks:/data/sdks:ro
      - /data/specs:/data/specs:ro
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - EXECUTE_LOCAL_COMMANDS=True
      - RESTRICT_TO_WORKSPACE=False
    restart: unless-stopped
```

### 8.2 Autonomous SDK Enhancement Prompt

Configure Kimi Claw with this system prompt:

```
You are an SDK architect. Your task:
1. Read OpenAPI specs from /data/specs/{id}/spec.yaml
2. Review generated SDKs from /data/sdks/{id}/
3. Identify missing features: pagination, retries, auth, error handling
4. Enhance the generated SDK to production quality
5. Write tests for critical endpoints
6. Update the state DB when complete

Rules:
- Always validate specs with swagger-parser before generation
- Add exponential backoff for 429/5xx errors
- Implement proper TypeScript types (strict mode)
- Generate README with usage examples
- If spec is missing, try to infer from n8n node source code
```

### 8.3 State-Aware Coding Loop

```python
# claw_bridge.py
import psycopg2
import os

DB_CONFIG = {
    "dbname": "n8n_sdk_pipeline",
    "user": "pipeline",
    "password": "your_secure_password",
    "host": "postgres",
    "port": 5432
}

def get_next_claw_task():
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    cur.execute("""
        SELECT id, node_name, spec_local_path, sdk_output_path, status
        FROM integration_state
        WHERE status IN ('sdk_generated', 'spec_downloaded')
        AND attempt_count < 5
        ORDER BY priority DESC, updated_at ASC
        LIMIT 1
    """)
    row = cur.fetchone()
    cur.close()
    conn.close()
    return row

def claw_workflow():
    task = get_next_claw_task()
    if not task:
        return "No tasks available"

    int_id, name, spec_path, sdk_path, status = task

    if status == 'spec_downloaded':
        prompt = f"""
        Generate a TypeScript SDK for {name}.
        Spec location: {spec_path}
        Output to: /data/sdks/{str(int_id).zfill(5)}/typescript/
        Requirements:
        - Use openapi-generator with typescript-fetch
        - Add retry logic (exponential backoff)
        - Add proper error types
        - Generate README.md with examples
        """
    elif status == 'sdk_generated':
        prompt = f"""
        Review and enhance SDK for {name}.
        SDK location: {sdk_path}
        Requirements:
        - Add pagination helpers
        - Add webhook/websocket support if AsyncAPI spec exists
        - Write Jest tests for 3 main endpoints
        - Ensure strict TypeScript compilation
        """

    os.makedirs("/data/claw-tasks", exist_ok=True)
    with open(f"/data/claw-tasks/task_{int_id}.md", "w") as f:
        f.write(prompt)

    return f"Task {int_id} queued for Claw"

if __name__ == "__main__":
    print(claw_workflow())
```

---

## 9. DOCKER COMPOSE: FULL VPS STACK

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    container_name: n8n_sdk_db
    environment:
      POSTGRES_DB: n8n_sdk_pipeline
      POSTGRES_USER: pipeline
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pipeline -d n8n_sdk_pipeline"]
      interval: 5s
      timeout: 5s
      retries: 5

  crawler:
    build: ./crawler
    container_name: n8n_crawler
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - ./crawler:/app
      - /data:/data
    environment:
      - DB_HOST=postgres
      - DB_PASSWORD=${DB_PASSWORD:-changeme}
    command: >
      sh -c "python crawler_n8n_core.py && python doc_scout.py"
    restart: "no"

  spec_downloader:
    build: ./crawler
    container_name: n8n_spec_downloader
    depends_on:
      - postgres
    volumes:
      - ./crawler:/app
      - /data/specs:/data/specs
    environment:
      - DB_HOST=postgres
      - DB_PASSWORD=${DB_PASSWORD:-changeme}
    command: >
      sh -c "while true; do python spec_downloader.py; sleep 300; done"
    restart: unless-stopped

  sdk_generator:
    build: ./sdk-generator
    container_name: n8n_sdk_generator
    depends_on:
      - postgres
    volumes:
      - ./sdk-generator:/app
      - /data/specs:/data/specs:ro
      - /data/sdks:/data/sdks
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - DB_HOST=postgres
      - DB_PASSWORD=${DB_PASSWORD:-changeme}
    command: >
      sh -c "while true; do python sdk_generator.py; sleep 600; done"
    restart: unless-stopped

  claw_bridge:
    build: ./claw-bridge
    container_name: n8n_claw_bridge
    depends_on:
      - postgres
    volumes:
      - ./claw-bridge:/app
      - /data/sdks:/data/sdks
      - /data/claw-tasks:/data/claw-tasks
    environment:
      - DB_HOST=postgres
      - DB_PASSWORD=${DB_PASSWORD:-changeme}
      - KIMI_CLAW_API_KEY=${KIMI_CLAW_API_KEY}
    ports:
      - "8080:8080"
    command: >
      sh -c "while true; do python claw_bridge.py; sleep 60; done"
    restart: unless-stopped

  dashboard:
    image: nginx:alpine
    container_name: n8n_sdk_dashboard
    volumes:
      - ./dashboard:/usr/share/nginx/html:ro
    ports:
      - "3000:80"
    restart: unless-stopped

volumes:
  pgdata:
```

---

## 10. DATABASE INITIALIZATION

```sql
CREATE TABLE IF NOT EXISTS integration_state (
    id SERIAL PRIMARY KEY,
    node_name VARCHAR(255) UNIQUE NOT NULL,
    app_name VARCHAR(255),
    node_type VARCHAR(50) CHECK (node_type IN ('core', 'community')),
    npm_package VARCHAR(255),
    github_url TEXT,
    docs_url TEXT,
    api_type VARCHAR(50) CHECK (api_type IN ('rest', 'graphql', 'websocket', 'grpc', 'soap', 'unknown')),
    spec_format VARCHAR(50) CHECK (spec_format IN ('openapi3', 'openapi2', 'asyncapi', 'graphql_schema', 'postman', 'none')),
    spec_url TEXT,
    spec_local_path TEXT,
    spec_downloaded_at TIMESTAMP,
    sdk_exists BOOLEAN DEFAULT FALSE,
    sdk_languages JSONB DEFAULT '[]',
    sdk_generated BOOLEAN DEFAULT FALSE,
    sdk_gen_language VARCHAR(50),
    sdk_output_path TEXT,
    sdk_quality_score FLOAT DEFAULT 0,
    n8n_node_exists BOOLEAN DEFAULT TRUE,
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'docs_found', 'spec_found', 'spec_downloaded', 'sdk_generated', 'sdk_tested', 'completed', 'failed', 'blocked')),
    error_log TEXT,
    attempt_count INT DEFAULT 0,
    last_attempted_at TIMESTAMP,
    priority INT DEFAULT 5,
    tags JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spec_discovery_log (
    id SERIAL PRIMARY KEY,
    integration_id INT REFERENCES integration_state(id) ON DELETE CASCADE,
    discovery_method VARCHAR(50),
    url_tested TEXT NOT NULL,
    response_status INT,
    content_type VARCHAR(255),
    found_spec BOOLEAN DEFAULT FALSE,
    probed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status ON integration_state(status);
CREATE INDEX IF NOT EXISTS idx_priority ON integration_state(priority DESC);
CREATE INDEX IF NOT EXISTS idx_node_type ON integration_state(node_type);
CREATE INDEX IF NOT EXISTS idx_spec_format ON integration_state(spec_format);
CREATE INDEX IF NOT EXISTS idx_discovery_integration ON spec_discovery_log(integration_id);
```

---

## 11. DEPLOYMENT CHECKLIST

### VPS Requirements
- **CPU**: 4+ cores (SDK generation is CPU-intensive)
- **RAM**: 8GB+ (Docker + OpenAPI Generator + DB)
- **Disk**: 100GB+ SSD (specs + generated SDKs)
- **OS**: Ubuntu 22.04 LTS or Debian 12
- **Docker & Docker Compose** installed

### Environment Variables (`.env`)
```
DB_PASSWORD=your_secure_random_password
OPENAI_API_KEY=sk-... (for OpenClaw if used locally)
KIMI_CLAW_API_KEY=... (for cloud Kimi Claw API)
```

### Cron Schedule (inside containers)
| Service | Frequency | Task |
|---------|-----------|------|
| Crawler | Daily at 02:00 | Refresh n8n integration list |
| Doc Scout | Every 30 min | Process 50 pending integrations |
| Spec Downloader | Every 5 min | Download found specs |
| SDK Generator | Every 10 min | Generate SDKs from downloaded specs |
| Claw Bridge | Every 1 min | Queue tasks for AI enhancement |

---

## 12. MONITORING QUERIES

```sql
-- Progress overview
SELECT 
    status,
    COUNT(*) as count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as pct
FROM integration_state
GROUP BY status
ORDER BY count DESC;

-- High-value targets (popular apps, no SDK yet)
SELECT node_name, app_name, spec_url, spec_format
FROM integration_state
WHERE sdk_generated = FALSE
  AND spec_format IN ('openapi3', 'openapi2')
  AND priority >= 7
ORDER BY priority DESC, attempt_count ASC
LIMIT 20;

-- Spec discovery success rate by method
SELECT 
    discovery_method,
    COUNT(*) as total,
    SUM(CASE WHEN found_spec THEN 1 ELSE 0 END) as found,
    ROUND(100.0 * SUM(CASE WHEN found_spec THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate
FROM spec_discovery_log
GROUP BY discovery_method
ORDER BY success_rate DESC;

-- SDK generation failures
SELECT node_name, error_log, attempt_count
FROM integration_state
WHERE status = 'failed'
  AND attempt_count >= 3
ORDER BY updated_at DESC;
```

---

## 13. ADVANCED: WEBSOCKET & GRAPHQL DETECTION

```python
# websocket_graphql_detector.py
import requests
import websocket

def detect_websocket(base_url):
    ws_endpoints = ["/ws", "/socket.io", "/websocket", "/wss", "/stream"]
    for endpoint in ws_endpoints:
        ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://") + endpoint
        try:
            ws = websocket.create_connection(ws_url, timeout=5)
            ws.close()
            return ws_url
        except:
            continue
    return None

def detect_graphql(base_url):
    gql_endpoints = ["/graphql", "/api/graphql", "/gql", "/query"]
    introspection_query = {"query": "{ __schema { types { name } } }"}
    for endpoint in gql_endpoints:
        url = base_url.rstrip("/") + endpoint
        try:
            resp = requests.post(url, json=introspection_query, timeout=10)
            if resp.status_code == 200 and "__schema" in resp.text:
                return url, resp.json()
        except:
            continue
    return None, None
```

---

## 14. SDK GENERATION STACK COMPARISON

| Tool | Cost | Languages | Best For |
|------|------|-----------|----------|
| **OpenAPI Generator** | Free (OSS) | 50+ | Bulk generation, all languages |
| **Stainless** | Paid | TS, Python, Go, Java, Ruby | Production-grade, retries, pagination |
| **Speakeasy** | Paid | TS, Python, Go, Java, C# | Enterprise governance |
| **Fern** | Freemium | 8+ languages | Docs + SDKs from same spec |
| **Hey API** | Free | TypeScript | TS-specific, modern fetch |

For this pipeline, start with **OpenAPI Generator** (Docker) for volume, then use **Kimi Claw** to enhance the top 20% of SDKs to production quality.

---

*Generated: 2026-08-11*
*Architecture Version: 1.0*
