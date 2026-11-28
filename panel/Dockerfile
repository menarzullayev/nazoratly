# Build context is the repository root (the panel imports the site's transliteration, web/lib/translit; the API types
# from clients/typescript are erased by the build and are only needed to type-check).
FROM node:24-alpine AS build
WORKDIR /app
COPY panel/package.json panel/package-lock.json panel/
RUN cd panel && npm ci --no-audit --no-fund
COPY panel panel
COPY web/lib/translit web/lib/translit
RUN cd panel && npm run build

FROM nginx:1.29-alpine
COPY panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY panel/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/panel/dist /usr/share/nginx/html/app
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/app/ >/dev/null || exit 1
