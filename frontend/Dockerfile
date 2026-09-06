# ── Stage 1: Build frontend ──────────────────────────────
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npx --yes npm@11.12.1 ci

FROM dependencies AS builder

COPY frontend/ /app/frontend/
COPY shared/ /app/shared/
RUN npx --yes npm@11.12.1 run build

# ── Stage 2: Serve with Nginx ────────────────────────────
FROM nginx:1.27.5-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

LABEL org.swarmoracle.build.node="22.23.2" org.swarmoracle.build.npm="11.12.1"

# Custom nginx config for SPA routing
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen       80;
    server_name  _;
    root         /usr/share/nginx/html;
    index        index.html;

    # SPA fallback — all unresolved paths go to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API + WebSocket to backend
    location /api/ {
        # Snapshot files may be 50 MiB; allow bounded multipart framing too.
        # Individual endpoints still enforce their narrower file limits.
        client_max_body_size 51m;
        # Forward report/conversation SSE progress without proxy buffering.
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_pass         http://backend:18927;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }

    location /ws/ {
        proxy_pass         http://backend:18927;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 300s;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
EOF

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
