FROM node:22-alpine

ENV NODE_ENV=production PORT=4000
WORKDIR /app

# A root-lockfile workspace install keeps deployed API dependencies reproducible.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --workspace @salon/api --include-workspace-root=false --ignore-scripts

COPY apps/api/src/ ./apps/api/src/
USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:4000/api/ready", {signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

CMD ["node", "apps/api/src/server.js"]
