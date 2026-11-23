# VariantShield API + dashboard, and the checkout demo (same image, different command).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Playwright is only needed for the Variant Bench; browsers are NOT downloaded into this image.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --include=optional || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY examples ./examples
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV VARIANTSHIELD_DB_PATH=/data/variantshield.db VARIANTSHIELD_BENCH_DIR=/data/bench HOST=0.0.0.0
EXPOSE 8787 8791
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "apps/api/src/main.ts"]
