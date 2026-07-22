# Verifox MCP server — HTTP transport (for Smithery / claude.ai / remote clients).
FROM node:20-alpine
WORKDIR /app
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev
ENV MCP_TRANSPORT=http
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
