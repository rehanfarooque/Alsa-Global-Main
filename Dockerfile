# =============================================================================
# AlsaGlobal — Docker Image
# =============================================================================
# Runs the Vite dev server which handles both the frontend and all /api/*
# routes via the built-in sebuf-api middleware plugin.
#
# Build: docker build -t alsaglobal .
# Run:   docker run -p 3001:3001 --env-file .env alsaglobal
# =============================================================================

FROM node:22-alpine

WORKDIR /app

# Install dependencies (layer-cached until package files change)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy full source
COPY . .

EXPOSE 3001

# Vite dev server bound to all interfaces.
# The sebuf-api plugin handles all /api/* routes inline.
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "3001"]
