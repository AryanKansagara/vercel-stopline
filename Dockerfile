# Official supported Node 24 LTS line; see deployment.md for verification and pinning limits.
FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data/stopline
WORKDIR /app
COPY --chown=node:node package.json server.mjs launch.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
RUN mkdir -p /data/stopline && chown node:node /data/stopline && chmod 0700 /data/stopline
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "launch.mjs"]
