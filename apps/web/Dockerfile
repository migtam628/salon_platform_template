FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace web --include-workspace-root=false --ignore-scripts

COPY apps/web/ ./apps/web/
ARG VITE_DEMO_MODE=false
ARG VITE_API_URL=
ARG VITE_APPWRITE_ENDPOINT=
ARG VITE_APPWRITE_PROJECT_ID=
ENV VITE_DEMO_MODE=$VITE_DEMO_MODE \
    VITE_API_URL=$VITE_API_URL \
    VITE_APPWRITE_ENDPOINT=$VITE_APPWRITE_ENDPOINT \
    VITE_APPWRITE_PROJECT_ID=$VITE_APPWRITE_PROJECT_ID
RUN npm run build -w web

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist/client/ /srv/salon/
EXPOSE 80 443
