# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0 AS web-console

ENV NOVA_CONSOLE_ORIGIN=https://nova.invalid \
    LUMEN_CONSOLE_ORIGIN=https://lumen.invalid \
    PULSO_CONSOLE_ORIGIN=https://pulso.invalid \
    NGINX_ENVSUBST_FILTER='^(NOVA_CONSOLE_ORIGIN|LUMEN_CONSOLE_ORIGIN|PULSO_CONSOLE_ORIGIN)$'

COPY default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
