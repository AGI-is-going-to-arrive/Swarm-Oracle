# ── Stage 1: Build frontend ──────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ /app/frontend/
COPY shared/ /app/shared/
RUN npm run build

# ── Stage 2: Serve with Nginx ────────────────────────────
FROM nginx:1.27-alpine

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
