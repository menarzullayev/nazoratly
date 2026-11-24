# Build context is the repository root (the site imports the product's own domain code from sheets/src/domain).
FROM node:24-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY web web
COPY sheets/src/domain sheets/src/domain
# NEXT_PUBLIC_* is baked into the static site at build time: empty = the "copy the demo Sheet" button is not rendered (docs/DEMO.md)
ARG NEXT_PUBLIC_DEMO_SHEET_COPY_URL=""
ENV NEXT_PUBLIC_DEMO_SHEET_COPY_URL=$NEXT_PUBLIC_DEMO_SHEET_COPY_URL
RUN cd web && npm run build

FROM nginx:1.29-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/web/out /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/robots.txt >/dev/null || exit 1
