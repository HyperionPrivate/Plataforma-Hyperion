# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:a718212f9cf21e241f14067333000a3f0930292f5354fe0db269e9a2a2596b9e AS web-console

ENV NOVA_CONSOLE_ORIGIN=https://nova.invalid \
    LUMEN_CONSOLE_ORIGIN=https://lumen.invalid \
    PULSO_CONSOLE_ORIGIN=https://pulso.invalid \
    NGINX_ENVSUBST_FILTER='^(NOVA_CONSOLE_ORIGIN|LUMEN_CONSOLE_ORIGIN|PULSO_CONSOLE_ORIGIN)$'

COPY default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
